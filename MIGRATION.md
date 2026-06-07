# Migration Guide: Old GV-Grok Bridge → Voicebridge

> This guide covers migrating from the legacy single-instance `gv-grok-bridge`
> to the new multi-instance `voicebridge` architecture.

## What Changed

| | Old | New |
|---|---|---|
| **Install location** | `~/project/` (user home) | `/opt/voicebridge` (system-wide) |
| **Commands** | `./run-bridge.sh`, `./start.sh` | `voicebridge setup`, `voicebridge start` |
| **Config** | Environment variables | YAML instance files in `~/.config/gv-bridge/instances/` |
| **Service** | System service `gv-grok-bridge.service` | User services `gv-bridge-<id>.service` |
| **Instances** | One bridge per user | Multiple bridges per user |
| **Display** | Hardcoded `:99` | Auto-allocated from `:99` upward |
| **Audio devices** | `pipe_gv_to_grok`, `pipe_grok_to_gv` | Namespaced per instance |

## Prerequisites

- You have `sudo` access on the target server
- The old bridge config is accessible (either in env vars or the systemd service file)
- You know the authorized phone numbers from the old setup

---

## Step 1: Stop the Old Bridge

SSH in as the user running the old bridge (or as root):

```bash
ssh -i ~/.ssh/martin_dsd_890_be gvgrok@dsd.890.be
```

Check the old service status:

```bash
sudo systemctl status gv-grok-bridge
```

Stop and disable it:

```bash
sudo systemctl stop gv-grok-bridge
sudo systemctl disable gv-grok-bridge
```

Kill any lingering processes:

```bash
pkill -9 -f 'node dist/main.js'
pkill -9 -f 'chromium'
```

---

## Step 2: Extract Old Configuration

Read the old config from the service file:

```bash
cat /etc/systemd/system/gv-grok-bridge.service
```

Look for these values:
- `GV_AUTHORIZED_NUMBERS` — your allowed callers
- `GV_AUTHORIZED_NAMES` — optional name allowlist
- `GV_HEADLESS` — usually `true`
- `GV_DISPLAY_NUM` — usually `:99`
- `GV_AUTO_ACCEPT` — usually `true`

Write them down. You'll need the phone numbers for the new setup.

---

## Step 3: Back Up the Old Installation

```bash
# As the gvgrok user
BACKUP="$HOME/gv-grok-bridge-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -r ~/project "$BACKUP/"
sudo cp /etc/systemd/system/gv-grok-bridge.service "$BACKUP/" 2>/dev/null || true
```

---

## Step 4: Remove the Old Service

```bash
sudo rm -f /etc/systemd/system/gv-grok-bridge.service
sudo systemctl daemon-reload
```

---

## Step 5: Install the New Voicebridge

Option A: Run the automatic migration script (recommended):

```bash
cd /tmp
git clone --depth 1 https://github.com/clawbunny/gv-grok-bridge.git
cd gv-grok-bridge
sudo ./scripts/install.sh
./scripts/migrate.sh
```

Option B: Manual install + manual instance creation:

```bash
# Install
cd /tmp
git clone --depth 1 https://github.com/clawbunny/gv-grok-bridge.git
cd gv-grok-bridge
sudo ./scripts/install.sh

# Create instance with your old config
voicebridge setup \
  --instance-id gvgrok-gv-grok-01 \
  --voice-provider google-voice \
  --ai-provider grok \
  --numbers "+12125551234,+13035556789" \
  --names "Alice,Bob"
```

---

## Step 6: Start and Enable

```bash
# Start now
voicebridge start gvgrok-gv-grok-01

# Auto-start on boot
voicebridge enable gvgrok-gv-grok-01

# Allow user services to start before login
sudo loginctl enable-linger gvgrok
```

---

## Step 7: Verify

```bash
# List all instances
voicebridge list

# Check status
voicebridge status gvgrok-gv-grok-01

# Follow logs
voicebridge logs gvgrok-gv-grok-01 -f
```

---

## Rollback (if needed)

If the new bridge doesn't work, restore the old one:

```bash
# Stop new instance
voicebridge stop gvgrok-gv-grok-01

# Restore old project
cp -r ~/gv-grok-bridge-backup-*/project ~/project

# Restore old service
sudo cp ~/gv-grok-bridge-backup-*/gv-grok-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gv-grok-bridge
sudo systemctl start gv-grok-bridge
```

---

## What the Automatic Script Does

`scripts/migrate.sh` performs all of the above automatically:

1. Detects the old `gv-grok-bridge.service` and `~/project` directory
2. Extracts config from the service file or environment variables
3. Stops and disables the old service
4. Backs up everything to `~/gv-grok-bridge-backup-<timestamp>/`
5. Removes the old systemd service file
6. Runs `scripts/install.sh` if voicebridge is not already installed
7. Creates a new instance via `voicebridge setup` with the migrated config
8. Starts and enables the new instance
9. Runs `loginctl enable-linger`

Run it with `--yes` to skip all prompts:

```bash
./scripts/migrate.sh --instance-id gvgrok-gv-grok-01 --yes
```

---

## Post-Migration Notes

- The old bridge's log file (`~/project/bridge.log`) is preserved in the backup.
- The new instance log is at `~/.local/state/gv-bridge/instances/<id>/bridge.log`.
- The Chromium profile is still at `~/.config/chromium` — no change needed.
- You can create additional instances with different providers:
  ```bash
  voicebridge setup -i work-bridge -v google-voice -a chatgpt -n "+12125551234"
  ```
