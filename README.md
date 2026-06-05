# Google Voice ↔ Grok AI Voice Bridge

An Ubuntu application that bridges incoming Google Voice calls to Grok AI's voice mode. Two Chromium instances are connected via virtual PulseAudio devices so callers can talk to Grok AI bidirectionally. Audio never plays through your physical speakers — it stays entirely between the two browser windows.

## What It Does

1. **Monitors** `voice.google.com` for incoming phone calls
2. **Filters** callers — only accepts calls from numbers you authorize
3. **Auto-answers** authorized calls in Google Voice
4. **Connects** the call audio to `grok.com` in voice/speak mode
5. **Grok AI** speaks to the caller and hears their responses
6. **Audio is virtual** — no sound comes out of your Ubuntu device's speakers

## Architecture

```
+──────────────+     PulseAudio Virtual     +──────────────+
│   GV Browser │◄────src_grok_to_gv─────────│ Grok Browser │
│voice.google  │                             │  grok.com    │
│  (receives   │────pipe_gv_to_grok───────►│  (AI talks   │
│   calls)     │    pipe_grok_to_gv        │   to caller) │
+──────────────+                             +──────────────+
```

Two PulseAudio null-sinks create virtual audio devices. Each Chromium browser is launched with `PULSE_SINK` and `PULSE_SOURCE` environment variables so their audio routes through the virtual devices instead of real hardware. Because Chromium's audio service runs as a separate process by default, we use `--disable-features=AudioServiceOutOfProcess` to force it in-process so the env vars are inherited. An automatic `fixStreamRouting()` monitor corrects any misrouted streams after voice mode activation.

## Requirements

- Ubuntu (or Debian-based Linux)
- Node.js 20+
- PulseAudio
- Xvfb (for headless mode)
- Pre-logged-in Chromium profile at `~/.config/chromium`

## Quick Start

### 1. One-time Setup

```bash
./setup.sh
```

This installs: PulseAudio, Xvfb, Node.js, Playwright Chromium.

### 2. Log In (Critical!)

You **must** be logged in to both services in your default Chromium profile:

- Open your regular Chromium browser
- Go to `https://voice.google.com` and log in with your Google account
- Go to `https://grok.com` and log in with your x.ai account
- **Close Chromium** (the bridge will use the same profile)

### 3. Configure Authorized Numbers

```bash
export GV_AUTHORIZED_NUMBERS="+12125551234,+13035556789"
export GV_AUTHORIZED_NAMES="Alice,Bob"        # Optional: match caller name
export GV_HEADLESS=true                         # Run with xvfb (default)
export GV_AUTO_ACCEPT=true                      # Auto-answer authorized calls
```

### 4. Start the Bridge

```bash
./start.sh
```

Or with environment variables inline:

```bash
GV_AUTHORIZED_NUMBERS="+12125551234" ./start.sh
```

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `GV_AUTHORIZED_NUMBERS` | — | Comma-separated authorized phone numbers in E.164 format (`+1XXXXXXXXXX`) |
| `GV_AUTHORIZED_NAMES` | — | Comma-separated substrings to match in caller name |
| `GV_HEADLESS` | `true` | Run with Xvfb (no visible window) |
| `GV_DISPLAY_NUM` | `:99` | Xvfb display number |
| `GV_AUTO_ACCEPT` | `true` | Auto-answer authorized calls |
| `GV_POLL_INTERVAL` | `1000` | DOM poll interval in ms for call detection |
| `GV_LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

## How It Works (Detailed)

### Audio Routing (PulseAudio)

The bridge creates 4 virtual PulseAudio devices:

| Device | Type | Role |
|--------|------|------|
| `pipe_gv_to_grok` | null-sink (`float32le`) | GV browser audio output |
| `pipe_grok_to_gv` | null-sink (`float32le`) | Grok browser audio output |
| `src_gv_to_grok` | remap-source | Feeds GV audio to Grok as microphone input |
| `src_grok_to_gv` | remap-source | Feeds Grok audio to GV as microphone input |

`float32le` format prevents integer clipping when WebRTC AGC pushes signal above 0 dBFS. Sinks are set to 70% volume on startup to create additional AGC headroom.

### Browser Launch

Two Chromium instances are launched via Playwright:

- **GV browser**: `PULSE_SINK=pipe_gv_to_grok PULSE_SOURCE=src_grok_to_gv PULSE_PROP_application.name=Chromium-GV` → `voice.google.com`
- **Grok browser**: `PULSE_SINK=pipe_grok_to_gv PULSE_SOURCE=src_gv_to_grok PULSE_PROP_application.name=Chromium-Grok` → `grok.com`

Both browsers share the same login session from your default Chromium profile (Grok uses a copy with `dereference: true` to avoid symlink lock conflicts). Before each launch, any lingering Chromium processes are killed and `SingletonLock`/`SingletonCookie`/`SingletonSocket` files are stripped from both profiles.

### Call Flow

```
IDLE → detects incoming call from authorized number
  → auto-clicks "Answer" in Google Voice
  → activates Grok voice/speak mode
  → BRIDGED (caller ↔ Grok AI)
  → detects call ended
  → deactivates Grok voice mode
  → IDLE
```

Unauthorized calls are automatically declined.

## Project Structure

```
project/
├── src/
│   ├── main.ts              # Entry point
│   ├── config.ts            # Environment config loader
│   ├── types.ts             # Shared TypeScript types
│   ├── audio/
│   │   └── pipeline.ts      # PulseAudio virtual device management
│   ├── browser/
│   │   └── manager.ts       # Dual Chromium Playwright launcher
│   ├── voice/
│   │   └── monitor.ts       # Google Voice incoming call detector
│   ├── grok/
│   │   └── controller.ts    # Grok voice mode activation
│   └── bridge/
│       └── orchestrator.ts  # Main controller & state machine
├── setup.sh                 # One-time Ubuntu setup
├── start.sh                 # Start the bridge
└── README.md                # This file
```

## Troubleshooting

### "Google Voice not logged in"

- Open Chromium normally, go to `voice.google.com`, log in, close the browser
- The bridge uses your default profile at `~/.config/chromium`

### "Grok not logged in"

- Same process: open Chromium, go to `grok.com`, log in, close browser

### No audio in the bridge

- Check PulseAudio: `pactl list sinks | grep pipe_` should show the null-sinks
- Check Xvfb is running: `ps aux | grep Xvfb`

### Call detection not working

- Google Voice may change their DOM. Check the logs for selector attempts.
- Increase log level: `GV_LOG_LEVEL=debug ./start.sh`

### "Chromium profile lock" error

- The bridge now automatically kills lingering Chromium processes and strips lock files before launch
- If you still see this error, manually run: `pkill -9 -f 'chromium'` and restart the bridge

### No audio / saturated audio

- Check sink format is `float32le`: `pactl list sinks short | grep pipe_`
- Check volume is at 70%: `pactl list sinks | grep Volume`
- Check both sources are RUNNING during a call: `pactl list sources short`
- Check source-outputs are on correct sources: `pactl list source-outputs short`
  - GV browser should be on `src_grok_to_gv`
  - Grok browser should be on `src_gv_to_grok`
- The bridge auto-corrects routing within 2-8 seconds of answering; if not, check `bridge.log` for `Moved source-output` messages

### PulseAudio module leaks

- If you see many numbered duplicates (`pipe_gv_to_grok.2`, `.3`, etc.), restart the bridge
- The bridge now cleans up stale modules automatically on startup

## License

MIT
