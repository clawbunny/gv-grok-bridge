# GV Bridge — Multi-Instance Voice Bridge

A modular, multi-instance Ubuntu application that bridges incoming voice calls to AI voice mode. Multiple users can run independent instances, and each user can run multiple bridges with different voice providers and AI backends.

## What It Does

1. **Monitors** a voice provider (e.g., Google Voice) for incoming calls
2. **Filters** callers — only accepts authorized numbers/names
3. **Auto-answers** authorized calls
4. **Connects** call audio to an AI provider (e.g., Grok) in voice/speak mode
5. **AI speaks** to the caller and hears responses bidirectionally
6. **Audio is virtual** — routed through PulseAudio null-sinks, never through physical speakers

## Supported Providers

| Voice Providers | AI Providers |
|-----------------|--------------|
| Google Voice    | Grok         |
| Twilio (stub)   | ChatGPT (stub) |

Adding a new provider requires implementing a single interface — see `docs/providers.md`.

## Requirements

- Ubuntu (or Debian-based Linux)
- Node.js 20+
- PulseAudio
- Xvfb (for headless mode)
- Pre-logged-in Chromium profile at `~/.config/chromium`

## Installation

### Option 1: From Source (Recommended for Development)

```bash
git clone https://github.com/clawbunny/gv-grok-bridge.git
cd gv-grok-bridge
sudo ./scripts/install.sh
```

### Option 2: From Release Tarball

```bash
tar -xzf voicebridge-2.0.0.tar.gz
cd voicebridge-2.0.0
sudo make install
```

### What the Installer Does

- Installs system dependencies: PulseAudio, Xvfb, Chromium deps, Node.js 20
- Installs npm dependencies and builds the TypeScript project
- Copies the built project to `/opt/voicebridge`
- Symlinks `voicebridge` and `voicebridge-run` into `/usr/local/bin`

### Uninstall

```bash
sudo ./scripts/uninstall.sh
```

This stops all instances, removes the system installation, and optionally cleans up all user data.

### Build a Release Tarball

```bash
make dist
# → dist/voicebridge-<version>.tar.gz
```

## Quick Start

### 1. Authenticate (Critical!)

The bridge requires active browser sessions for both providers. See [`docs/authentication.md`](docs/authentication.md) for the full workflow, including cookie import for headless servers.

In short:

- Stop the bridge: `voicebridge stop <instance-id>`
- Open Chromium with the bridge profile and log in to both providers
- Close Chromium properly (Ctrl+Q)
- Start the bridge: `voicebridge start <instance-id>`

### 2. Create an Instance

```bash
voicebridge setup
```

Or non-interactively:

```bash
voicebridge setup \
  --instance-id martin-gv-grok-01 \
  --voice-provider google-voice \
  --ai-provider grok \
  --numbers "+12125551234,+13035556789"
```

### 3. Start the Instance

```bash
voicebridge start martin-gv-grok-01
```

Enable auto-start on boot:

```bash
voicebridge enable martin-gv-grok-01
```

### 4. Manage Instances

```bash
# List all instances
voicebridge list

# View status
voicebridge status martin-gv-grok-01

# View logs
voicebridge logs martin-gv-grok-01 -f

# Stop
voicebridge stop martin-gv-grok-01

# Restart
voicebridge restart martin-gv-grok-01

# Edit config
voicebridge config martin-gv-grok-01

# Destroy (removes everything)
voicebridge destroy martin-gv-grok-01
```

## Architecture

Each **instance** is fully isolated:

- Unique PulseAudio device namespace (`pipe_voice_to_ai_<instance>`, etc.)
- Dedicated Xvfb display number
- Separate Chromium profile copy
- Per-instance systemd user service
- Independent log file

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI: voicebridge                        │
│  setup | list | status | start | stop | restart | logs      │
│  enable | disable | config | destroy                        │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌─────────────────┐    ┌─────────────┐
│ Instance A    │    │ Instance B      │    │ Instance C  │
│ (google-voice │    │ (twilio →       │    │ (google-    │
│  → grok)      │    │  chatgpt)       │    │  voice →    │
│               │    │                 │    │  chatgpt)   │
└───────────────┘    └─────────────────┘    └─────────────┘
```

## Instance Configuration

Instances are stored as YAML files in `~/.config/gv-bridge/instances/<id>.yaml`:

```yaml
instanceId: martin-gv-grok-01
voiceProvider:
  type: google-voice
aiProvider:
  type: grok
authorizedNumbers:
  - "+12125551234"
authorizedNames:
  - "Alice"
headless: true
displayNum: ":99"
autoAccept: true
pollInterval: 1000
logLevel: info
profilePath: /home/martin/.config/chromium
```

## Project Structure

```
src/
├── main.ts                    # Single-instance runtime entry
├── types.ts                   # Shared TypeScript types
├── logger.ts                  # Structured logging
├── instance/
│   ├── config.ts              # InstanceConfig schema
│   ├── registry.ts            # Instance CRUD (YAML)
│   ├── paths.ts               # Per-instance path utilities
│   └── display-pool.ts        # Xvfb display allocator
├── providers/
│   ├── contracts.ts           # VoiceProvider + AIProvider interfaces
│   ├── index.ts               # Provider factory
│   ├── voice/
│   │   ├── google-voice/      # Google Voice provider
│   │   └── twilio/            # Twilio stub
│   └── ai/
│       ├── grok/              # Grok provider
│       └── chatgpt/           # ChatGPT stub
├── runtime/
│   ├── audio/pipeline.ts      # Namespaced PulseAudio management
│   ├── browser/manager.ts     # Dual Chromium launcher
│   ├── monitor.ts             # Generic voice monitor
│   ├── ai-controller.ts       # Generic AI controller
│   ├── orchestrator.ts        # Main state machine
│   └── xvfb.ts                # Xvfb lifecycle
└── cli/
    ├── main.ts                # CLI entry point
    ├── commands/              # All CLI commands
    └── systemd/template.ts    # Service file generator
```

## Multi-User Support

Instances run as **systemd user services** (`systemctl --user`), so:

- Each Linux user manages their own instances independently
- No root required for setup, start, stop, or config changes
- To auto-start before login, run: `loginctl enable-linger $USER`

## Legacy Mode

If you prefer the old single-instance env-var mode:

```bash
export GV_AUTHORIZED_NUMBERS="+12125551234"
export GV_VOICE_PROVIDER="google-voice"
export GV_AI_PROVIDER="grok"
voicebridge-run
```

## Troubleshooting

### Provider not logged in
- Open Chromium normally, go to the provider URL, log in, close browser
- The bridge uses your default profile at `~/.config/chromium`

### No audio in the bridge
- Check PulseAudio: `pactl list sinks short | grep pipe_`
- Check Xvfb is running: `ps aux | grep Xvfb`

### Call detection not working
- Providers may change their DOM. Check logs for selector attempts.
- Increase log level in instance config to `debug`

### PulseAudio module leaks
- Each instance cleans up its own stale modules on startup
- If you see duplicates, restart the instance: `voicebridge restart <id>`

## Monitoring & Alerting

### Enhanced Status Command

`voicebridge status` now shows both systemd service state **and** the bridge's internal health:

```bash
voicebridge status my-instance
```

Output includes:
- Systemd service state (active/inactive)
- Bridge internal state (running, audio ready, browser readiness, login state)
- **Critical issues** (e.g., "Voice provider not logged in")
- Exit code `1` if critical issues are detected

### Email Alerts

Configure an alert email address in your instance YAML to receive notifications when critical failures occur:

```yaml
instanceId: my-instance
voiceProvider:
  type: google-voice
aiProvider:
  type: grok
alertEmail: admin@example.com
```

**Critical failures** that trigger alerts:
- Voice provider not logged in
- AI provider not logged in
- Browser not ready
- Audio pipeline not ready
- Bridge not running

Alerts are rate-limited to **one per hour per issue type** to avoid spam. They reset when the issue is resolved.

**Prerequisite:** The server must have an MTA installed (e.g., `postfix`, `nullmailer`, or `msmtp`) providing `/usr/sbin/sendmail`. If sendmail is not found, alerts are logged as warnings.

### Status File

The bridge writes its current state to `~/.local/state/gv-bridge/instances/<id>/status.json` every 10 seconds. This allows the `voicebridge status` command to inspect runtime health without IPC.

## License

MIT
