# SPEC.md — Google Voice ↔ Grok Voice Bridge

## 1. Overview

A headless Ubuntu application that bridges incoming Google Voice calls to Grok AI's voice mode. Two Chromium instances (Playwright + CDP) are connected via virtual PulseAudio devices so the caller talks to Grok AI bidirectionally. Audio never plays through physical speakers.

## 2. System Architecture

```
+--------------+     PulseAudio      +-------------+
|  GV Browser  |<--pipe_grok_to_gv---| Grok Browser|
|voice.google  |---pipe_gv_to_grok-->|  grok.com   |
+--------------+                     +-------------+
      |                                      |
      | CDP events                           | CDP / Page actions
      v                                      v
+--------------+                     +-------------+
| GV Monitor   |                     | Grok Ctrl   |
| (call detect,|                     | (voice mode,|
|  auth filter)|                     |  mic enable) |
+--------------+                     +-------------+
      |                                      |
      v                                      v
      +--------------+  +-------------------+
                     |  |
                     v  v
            +------------------+
            | Bridge Controller |
            | (orchestrator)    |
            +------------------+
                     |
                     v
            +------------------+
            | Audio Pipeline    |
            | (PulseAudio)      |
            +------------------+
```

## 3. Module Specifications

### 3.1 Audio Pipeline (`src/audio/pipeline.ts`)

Manages PulseAudio virtual audio devices using `pactl` commands.

#### Device Map
| Device | Type | Name | Purpose |
|--------|------|------|---------|
| Sink A | null-sink | `pipe_gv_to_grok` | GV browser audio output → Grok input |
| Sink B | null-sink | `pipe_grok_to_gv` | Grok browser audio output → GV input |
| Source A | remap-source | `src_gv_to_grok` | Exposes Sink A monitor as named source for Grok |
| Source B | remap-source | `src_grok_to_gv` | Exposes Sink B monitor as named source for GV |

#### Interface
```typescript
export interface AudioPipeline {
  /** Initialize all PulseAudio devices. Returns device IDs for cleanup. */
  setup(): Promise<AudioDevices>;
  
  /** Tear down all PulseAudio devices. */
  teardown(devices: AudioDevices): Promise<void>;
  
  /** Check PulseAudio is running, install if needed. */
  ensurePulseAudio(): Promise<void>;
  
  /** Fix Chromium source-output routing so each browser records from the correct virtual source. */
  fixStreamRouting(gvUserDataDir: string, grokUserDataDir: string): Promise<void>;
}

export interface AudioDevices {
  gvSink: number;       // module ID for pipe_gv_to_grok
  grokSink: number;     // module ID for pipe_grok_to_gv
  gvSource: number;     // module ID for src_gv_to_grok
  grokSource: number;   // module ID for src_grok_to_gv
}
```

#### Implementation Details
- Use `pactl load-module module-null-sink format=float32le` with `sink_properties=device.description=...`
- Use `pactl load-module module-remap-source master=SINK_NAME.monitor`
- Store module IDs returned by pactl for teardown
- Use `child_process.exec` / `execSync` for pactl commands
- `ensurePulseAudio()`: check `pactl info`, if fail → `pulseaudio --start` or install via apt
- `cleanupExistingModules()`: on setup, unload any previously-loaded bridge modules to avoid duplicates
- `setSinkVolumes()`: after setup, set both null-sinks to 70% volume to create AGC headroom
- `fixStreamRouting()`: dynamically looks up current source IDs by name, finds Chromium PIDs by `--user-data-dir`, and moves misrouted source-outputs to the correct virtual source. Called after voice mode activation and during health checks while in-call.

---

### 3.2 Browser Manager (`src/browser/manager.ts`)

Launches and manages two Chromium instances via Playwright.

#### Interface
```typescript
export interface BrowserManager {
  /** Launch both browsers. Returns handles for each. */
  launch(config: BrowserConfig): Promise<BrowserPair>;
  
  /** Gracefully close both browsers. */
  close(): Promise<void>;
  
  /** Get CDP session for a browser instance. */
  getCDPSession(instance: 'gv' | 'grok'): Promise<CDPSession>;
  
  /** Check if either browser has crashed. */
  healthCheck(): Promise<boolean>;
}

export interface BrowserConfig {
  /** Path to default Chromium profile (e.g., /home/user/.config/chromium) */
  defaultProfilePath: string;
  /** Path to copy profile for second browser instance */
  tempProfilePath: string;
  /** Whether to run headless (xvfb) or with display */
  headless: boolean;
  /** xvfb display number if headless (e.g., ":99") */
  displayNum?: number;
  /** Extra chromium args */
  extraArgs?: string[];
}

export interface BrowserPair {
  gv: BrowserContext;      // Playwright BrowserContext for GV
  grok: BrowserContext;    // Playwright BrowserContext for Grok
  gvPage: Page;            // Primary page for GV
  grokPage: Page;          // Primary page for Grok
}
```

#### Implementation Details
- Use `playwright.chromium.launchPersistentContext()` for both
- GV browser env: `PULSE_SINK=pipe_gv_to_grok`, `PULSE_SOURCE=src_grok_to_gv`, `PULSE_PROP_application.name=Chromium-GV`
- Grok browser env: `PULSE_SINK=pipe_grok_to_gv`, `PULSE_SOURCE=src_gv_to_grok`, `PULSE_PROP_application.name=Chromium-Grok`
- GV profile: use `defaultProfilePath` directly
- Grok profile: copy `defaultProfilePath` to `tempProfilePath` before launch (use `cp -r` with `dereference: true`)
- Strip `SingletonLock`, `SingletonCookie`, `SingletonSocket` from BOTH source and temp profiles before launch
- Kill lingering Chromium processes (`pkill -9 -f 'chromium'`) before launch to prevent "profile in use" errors
- Both browsers need `--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess` (AudioServiceOutOfProcess forces audio service in-process so PULSE_SINK/PULSE_SOURCE are inherited)
- Both need `--use-fake-ui-for-media-stream` (auto-grant mic permissions)
- Use system Chromium binary (`executablePath: '/usr/lib/chromium/chromium'`) to avoid automation detection on grok.com and profile incompatibility with Playwright's downloaded binary
- Grant mic permissions per-origin via Playwright `context.grantPermissions()`
- Headless mode: use Xvfb (`xvfb-run` or manual Xvfb) since Chromium audio doesn't work in `--headless=new`
- Log CDP traffic for debugging

---

### 3.3 Google Voice Monitor (`src/voice/monitor.ts`)

Monitors voice.google.com for incoming calls and manages call state.

#### Interface
```typescript
export interface VoiceMonitor {
  /** Start monitoring for incoming calls. */
  startMonitoring(page: Page, config: VoiceConfig): Promise<void>;
  
  /** Stop monitoring. */
  stopMonitoring(): Promise<void>;
  
  /** Check if currently in a call. */
  isInCall(): boolean;
  
  /** Get current caller info (null if no active call). */
  getCurrentCall(): CallInfo | null;
  
  /** Events */
  on(event: 'incomingCall', handler: (call: CallInfo) => void): void;
  on(event: 'callAccepted', handler: (call: CallInfo) => void): void;
  on(event: 'callEnded', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

export interface VoiceConfig {
  /** List of authorized phone numbers (E.164 format, e.g., +12125551234) */
  authorizedNumbers: string[];
  /** Also accept calls from contacts whose name contains these strings */
  authorizedNames?: string[];
  /** Auto-accept authorized calls? */
  autoAccept: boolean;
  /** Poll interval in ms (default: 1000) */
  pollInterval?: number;
}

export interface CallInfo {
  phoneNumber: string;
  callerName: string;
  timestamp: Date;
}
```

#### Implementation Details
- Navigate to `https://voice.google.com` with `waitUntil: 'domcontentloaded'` (not `networkidle`, which times out on GV's persistent background requests)
- Check if redirected to login page (unauthenticated)
- Poll DOM every `pollInterval` ms
- **Incoming call detection**: Look for elements with:
  - Text containing "Incoming call" or similar
  - Answer/Decline buttons visible
  - Caller number in specific selectors
- **DOM Selectors** (voice.google.com — verified working):
  - Incoming call container: `div[gv-test-id="incoming-call"]`
  - Caller number: extracted from `active-call-wrapper` container only (not whole page body)
  - Answer button: `[gv-test-id="in-call-pickup-call"]` (aria-label="Answer call")
  - Decline/Hang up button: `[gv-test-id="in-call-end-call"]` (aria-label="Hang up call")
  - Mute button: `[gv-test-id="mute-button"]` (disabled when no mic available)
  - Call end detection: absence of `[gv-test-id="in-call-end-call"]`
- Extract phone number, normalize to E.164 (+1XXXXXXXXXX)
- Check against `authorizedNumbers` array
- If authorized + `autoAccept`: programmatically click answer button
- If not authorized: click decline button
- Monitor for call end: answer/decline buttons disappear, or "call ended" text appears
- Use `page.evaluate()` for DOM queries
- Log all call events

---

### 3.4 Grok Controller (`src/grok/controller.ts`)

Manages grok.com and activates voice/speak mode.

#### Interface
```typescript
export interface GrokController {
  /** Navigate to grok.com and ensure logged in. */
  initialize(page: Page): Promise<boolean>; // returns isLoggedIn
  
  /** Activate voice/speak mode. */
  activateVoiceMode(page: Page): Promise<boolean>;
  
  /** Deactivate voice mode. */
  deactivateVoiceMode(page: Page): Promise<boolean>;
  
  /** Check if currently in voice mode. */
  isVoiceModeActive(): boolean;
  
  /** Check if user is logged into Grok. */
  checkLoggedIn(page: Page): Promise<boolean>;
}
```

#### Implementation Details
- Navigate to `https://grok.com`
- **Login check**: Look for login button vs chat interface
  - If redirected to login or `button:has-text("Log in")` visible → not logged in
  - If textarea/input for message visible → logged in
- **Voice mode activation**:
  - Look for microphone/voice button (typically an icon button near message input)
  - Selector: `button[aria-label*="voice"]`, `button[aria-label*="microphone"]`, or button with mic icon
  - May need to click to activate
  - Grok may show a "Speak" button or mode toggle
  - After activation, grok starts listening via getUserMedia()
- Grant microphone permission: `page.context().grantPermissions(['microphone'], {origin: 'https://grok.com'})`
- The audio from GV (via PulseAudio source) feeds into Grok's WebRTC mic stream
- Grok's audio output goes through PulseAudio to GV's input
- Monitor for voice mode state changes

---

### 3.5 Bridge Orchestrator (`src/bridge/orchestrator.ts`)

Connects all modules and manages the overall call flow.

#### Interface
```typescript
export interface BridgeOrchestrator {
  /** Start the full bridge. */
  start(config: BridgeConfig): Promise<void>;
  
  /** Graceful shutdown. */
  stop(): Promise<void>;
  
  /** Get current status. */
  getStatus(): BridgeStatus;
}

export interface BridgeConfig {
  /** Path to default Chromium profile */
  defaultProfilePath: string;
  /** Authorized phone numbers */
  authorizedNumbers: string[];
  /** Headless mode */
  headless: boolean;
  /** xvfb display number */
  displayNum?: number;
}

export interface BridgeStatus {
  running: boolean;
  audioReady: boolean;
  gvBrowserReady: boolean;
  grokBrowserReady: boolean;
  gvLoggedIn: boolean;
  grokLoggedIn: boolean;
  inCall: boolean;
  currentCall?: CallInfo;
  voiceModeActive: boolean;
}
```

#### Call Flow State Machine
```
[INIT] → Setup PulseAudio → Launch Browsers → Check Logins → [IDLE]
                                                       ↓
                                          (incoming call detected)
                                                       ↓
                                            [CHECK_AUTH] → unauthorized → Decline → [IDLE]
                                                       ↓ authorized
                                            [ACCEPT_CALL] → Click Answer → [WAITING_CALL_ACTIVE]
                                                       ↓
                                            [ACTIVATE_GROK] → Activate voice mode → [BRIDGED]
                                                       ↓
                                            (call ended)
                                                       ↓
                                            [DEACTIVATE_GROK] → Deactivate → [IDLE]
```

#### Implementation Details
- Instantiate all modules
- Event wiring:
  - `VoiceMonitor.on('incomingCall')` → check auth → accept/decline
  - `VoiceMonitor.on('callAccepted')` → `GrokController.activateVoiceMode()`
  - `VoiceMonitor.on('callEnded')` → `GrokController.deactivateVoiceMode()`
- Health check loop: periodically verify both browsers alive
- On shutdown: deactivate Grok voice, close browsers, teardown PulseAudio
- SIGTERM/SIGINT handlers in `main.ts` call `bridge.stop()` for graceful shutdown
- Log all state transitions

---

## 4. Project File Structure

```
project/
├── package.json
├── tsconfig.json
├── .env.example
├── setup.sh                          # One-time Ubuntu setup script
├── start.sh                          # Start the bridge
├── src/
│   ├── main.ts                       # Entry point
│   ├── config.ts                     # Config loading (env vars + CLI args)
│   ├── types.ts                      # Shared TypeScript types
│   ├── audio/
│   │   └── pipeline.ts               # PulseAudio device management
│   ├── browser/
│   │   └── manager.ts                # Playwright Chromium management
│   ├── voice/
│   │   └── monitor.ts                # Google Voice call monitoring
│   ├── grok/
│   │   └── controller.ts             # Grok voice mode control
│   └── bridge/
│       └── orchestrator.ts           # Main orchestrator
└── README.md                         # Usage instructions
```

---

## 5. Configuration

### Environment Variables / CLI Args
| Variable | Default | Description |
|----------|---------|-------------|
| `GV_PROFILE_PATH` | `~/.config/chromium` | Default Chromium profile path |
| `GV_AUTHORIZED_NUMBERS` | — | Comma-separated authorized phone numbers |
| `GV_AUTHORIZED_NAMES` | — | Comma-substr match for caller names |
| `GV_HEADLESS` | `true` | Run headless with xvfb |
| `GV_DISPLAY_NUM` | `:99` | Xvfb display number |
| `GV_LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |

---

## 6. Setup Requirements

### System Packages (Ubuntu)
```bash
# PulseAudio
sudo apt-get update
sudo apt-get install -y pulseaudio pulseaudio-utils

# Chromium dependencies
sudo apt-get install -y chromium-browser xvfb

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Playwright browsers
npx playwright install chromium
npx playwright install-deps chromium
```

---

## 7. Key Technical Decisions

1. **PulseAudio over ALSA/JACK**: PulseAudio is default on Ubuntu, simpler null-sink setup
2. **Two browser instances over one**: Audio routing requires separate PULSE_SINK/PULSE_SOURCE per process
3. **Shared profile via copy**: Chromium locks profile dirs; GV uses real profile, Grok uses copy
4. **Xvfb over --headless=new**: Chromium audio (including WebRTC output capture) doesn't work in true headless
5. **DOM polling over CDP Network**: GV is a SPA; call state is in DOM, not network requests
6. **Playwright over Puppeteer**: Better profile management, grantPermissions API

---

## 8. Error Handling & Resilience

- Browser crash → health check fails, status updated (auto-restart not yet implemented)
- PulseAudio failure → attempt restart, exit if unrecoverable
- Login failure → log error, retry every 60s
- Call dropped → reset to IDLE, deactivate Grok voice
- Network issues → Playwright auto-retry on navigation

---

## 9. Logging

Use structured logging (console with timestamps + log level). Log:
- All state transitions
- Call events (incoming, accepted, ended)
- Auth decisions (allowed/denied with number)
- Browser lifecycle (launch, crash, close)
- Audio device setup/teardown
- Errors with stack traces
