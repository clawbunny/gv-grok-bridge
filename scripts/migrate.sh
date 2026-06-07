#!/bin/bash
# migrate.sh — Migrate from old single-instance gv-grok-bridge to new voicebridge.
#
# Run this ON the target server as the user running the old bridge (gvgrok),
# or as root with sudo.
#
# What it does:
#   1. Detects old bridge installation (~/project, systemd service, env vars)
#   2. Extracts configuration (authorized numbers, names, headless, display, etc.)
#   3. Stops and disables the old systemd service
#   4. Backs up old installation
#   5. Installs new voicebridge (if not already installed)
#   6. Creates a new instance with migrated config
#   7. Optionally starts/enables the new instance
#
# Usage:
#   ./scripts/migrate.sh
#   ./scripts/migrate.sh --instance-id my-bridge --yes

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}[migrate]${NC} $1"; }
ok()  { echo -e "${GREEN}[migrate]${NC} $1"; }
warn() { echo -e "${YELLOW}[migrate]${NC} $1"; }
err()  { echo -e "${RED}[migrate]${NC} $1"; }

# ── Parse args ───────────────────────────────────────────
INSTANCE_ID=""
YES=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --instance-id)
      INSTANCE_ID="$2"
      shift 2
      ;;
    --yes)
      YES=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--instance-id <id>] [--yes]"
      echo ""
      echo "  --instance-id <id>  Pre-set the new instance ID (default: <user>-gv-grok-01)"
      echo "  --yes               Skip confirmation prompts"
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Detect old bridge ────────────────────────────────────
OLD_SERVICE="gv-grok-bridge.service"
OLD_SERVICE_PATH="/etc/systemd/system/$OLD_SERVICE"
OLD_PROJECT_DIR=""
OLD_ACTIVE=false
OLD_ENABLED=false

# Try to find old project directory
for dir in "$HOME/project" "$HOME/gv-grok-bridge" "/opt/gv-grok-bridge"; do
  if [ -f "$dir/dist/main.js" ] || [ -f "$dir/run-bridge.sh" ]; then
    OLD_PROJECT_DIR="$dir"
    break
  fi
done

# Check systemd status
if systemctl is-active "$OLD_SERVICE" &>/dev/null; then
  OLD_ACTIVE=true
fi
if systemctl is-enabled "$OLD_SERVICE" &>/dev/null; then
  OLD_ENABLED=true
fi

if [ -z "$OLD_PROJECT_DIR" ] && [ "$OLD_ACTIVE" = false ] && [ "$OLD_ENABLED" = false ]; then
  warn "No old gv-grok-bridge installation detected."
  warn "Looked for: ~/project, ~/gv-grok-bridge, /opt/gv-grok-bridge, and $OLD_SERVICE"
  echo ""
  read -p "Continue with fresh install anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 0
else
  ok "Old bridge detected!"
  echo "  Project dir: ${OLD_PROJECT_DIR:-'(not found)' }"
  echo "  Service:     $OLD_SERVICE"
  echo "  Status:      $([ "$OLD_ACTIVE" = true ] && echo 'active' || echo 'inactive')"
  echo "  Enabled:     $([ "$OLD_ENABLED" = true ] && echo 'enabled' || echo 'disabled')"
  echo ""
fi

# ── Extract old config ───────────────────────────────────
log "Extracting old configuration..."

# Try to read from env vars in the service file
if [ -f "$OLD_SERVICE_PATH" ]; then
  OLD_NUMBERS=$(grep -oP 'GV_AUTHORIZED_NUMBERS=\K[^"]+' "$OLD_SERVICE_PATH" || echo "")
  OLD_NAMES=$(grep -oP 'GV_AUTHORIZED_NAMES=\K[^"]+' "$OLD_SERVICE_PATH" || echo "")
  OLD_HEADLESS=$(grep -oP 'GV_HEADLESS=\K[^"]+' "$OLD_SERVICE_PATH" || echo "true")
  OLD_DISPLAY=$(grep -oP 'GV_DISPLAY_NUM=\K[^"]+' "$OLD_SERVICE_PATH" || echo ":99")
  OLD_AUTO_ACCEPT=$(grep -oP 'GV_AUTO_ACCEPT=\K[^"]+' "$OLD_SERVICE_PATH" || echo "true")
  OLD_LOG_LEVEL=$(grep -oP 'GV_LOG_LEVEL=\K[^"]+' "$OLD_SERVICE_PATH" || echo "info")
fi

# Fallback: try current shell env vars
OLD_NUMBERS="${OLD_NUMBERS:-$GV_AUTHORIZED_NUMBERS}"
OLD_NAMES="${OLD_NAMES:-$GV_AUTHORIZED_NAMES}"
OLD_HEADLESS="${OLD_HEADLESS:-${GV_HEADLESS:-true}}"
OLD_DISPLAY="${OLD_DISPLAY:-${GV_DISPLAY_NUM:-:99}}"
OLD_AUTO_ACCEPT="${OLD_AUTO_ACCEPT:-${GV_AUTO_ACCEPT:-true}}"
OLD_LOG_LEVEL="${OLD_LOG_LEVEL:-${GV_LOG_LEVEL:-info}}"

# Parse numbers into comma-separated string
NUMBERS_ARG=""
if [ -n "$OLD_NUMBERS" ] && [ "$OLD_NUMBERS" != "+1XXXXXXXXXX" ]; then
  NUMBERS_ARG="$OLD_NUMBERS"
fi

# Parse names into comma-separated string
NAMES_ARG=""
if [ -n "$OLD_NAMES" ]; then
  NAMES_ARG="$OLD_NAMES"
fi

# Determine default instance ID
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID="${USER}-gv-grok-01"
fi

echo ""
echo "=========================================="
echo "  Migration Plan"
echo "=========================================="
echo ""
echo "  Old service:     $OLD_SERVICE"
echo "  Old project:     ${OLD_PROJECT_DIR:-'(unknown)' }"
echo "  Old numbers:     ${NUMBERS_ARG:-'(none extracted)' }"
echo "  Old names:       ${NAMES_ARG:-'(none extracted)' }"
echo "  Old headless:    $OLD_HEADLESS"
echo "  Old display:     $OLD_DISPLAY"
echo ""
echo "  New instance ID: $INSTANCE_ID"
echo "  New voice:       google-voice"
echo "  New AI:          grok"
echo ""

if [ "$YES" = false ]; then
  read -p "Proceed with migration? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
fi

# ── Step 1: Stop old bridge ──────────────────────────────
log "Step 1: Stopping old bridge..."
if [ "$OLD_ACTIVE" = true ] || [ "$OLD_ENABLED" = true ]; then
  sudo systemctl stop "$OLD_SERVICE" 2>/dev/null || true
  sudo systemctl disable "$OLD_SERVICE" 2>/dev/null || true
  ok "Old service stopped and disabled."
else
  log "Old service not running."
fi

# Also kill any lingering bridge process
pkill -9 -f 'node dist/main.js' 2>/dev/null || true
pkill -9 -f 'chromium' 2>/dev/null || true
sleep 1
ok "Old processes killed."

# ── Step 2: Back up old installation ─────────────────────
log "Step 2: Backing up old installation..."
BACKUP_DIR="$HOME/gv-grok-bridge-backup-$(date +%Y%m%d-%H%M%S)"
if [ -n "$OLD_PROJECT_DIR" ] && [ -d "$OLD_PROJECT_DIR" ]; then
  cp -r "$OLD_PROJECT_DIR" "$BACKUP_DIR"
  ok "Old project backed up to: $BACKUP_DIR"
fi

# Backup old service file
if [ -f "$OLD_SERVICE_PATH" ]; then
  sudo cp "$OLD_SERVICE_PATH" "$BACKUP_DIR/$OLD_SERVICE" 2>/dev/null || true
  ok "Old service file backed up."
fi

# Backup old env vars
{
  echo "# Old gv-grok-bridge environment variables"
  echo "GV_AUTHORIZED_NUMBERS=$OLD_NUMBERS"
  echo "GV_AUTHORIZED_NAMES=$OLD_NAMES"
  echo "GV_HEADLESS=$OLD_HEADLESS"
  echo "GV_DISPLAY_NUM=$OLD_DISPLAY"
  echo "GV_AUTO_ACCEPT=$OLD_AUTO_ACCEPT"
  echo "GV_LOG_LEVEL=$OLD_LOG_LEVEL"
} > "$BACKUP_DIR/old-env-vars.txt"
ok "Old env vars backed up to: $BACKUP_DIR/old-env-vars.txt"

# ── Step 3: Remove old systemd service ───────────────────
log "Step 3: Removing old systemd service..."
if [ -f "$OLD_SERVICE_PATH" ]; then
  sudo rm -f "$OLD_SERVICE_PATH"
  sudo systemctl daemon-reload
  ok "Old service file removed from /etc/systemd/system/"
fi

# ── Step 4: Install new voicebridge ──────────────────────
log "Step 4: Installing new voicebridge..."
if command -v voicebridge &>/dev/null; then
  ok "voicebridge already installed."
else
  # Try to install from the directory containing this script
  MIGRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$MIGRATE_DIR/../package.json" ]; then
    REPO_ROOT="$(cd "$MIGRATE_DIR/.." && pwd)"
    log "Installing from: $REPO_ROOT"
    sudo "$REPO_ROOT/scripts/install.sh"
  elif [ -f "$MIGRATE_DIR/install.sh" ]; then
    log "Installing from: $MIGRATE_DIR"
    sudo "$MIGRATE_DIR/install.sh"
  else
    warn "voicebridge not installed and install.sh not found."
    warn "Please run install.sh manually, then re-run this migration."
    exit 1
  fi
fi

# ── Step 5: Create new instance ──────────────────────────
log "Step 5: Creating new instance with migrated config..."

SETUP_ARGS=(
  setup
  --instance-id "$INSTANCE_ID"
  --voice-provider google-voice
  --ai-provider grok
  --headless "$OLD_HEADLESS"
)

if [ -n "$NUMBERS_ARG" ]; then
  SETUP_ARGS+=(--numbers "$NUMBERS_ARG")
fi

if [ -n "$NAMES_ARG" ]; then
  SETUP_ARGS+=(--names "$NAMES_ARG")
fi

# Run voicebridge setup non-interactively
voicebridge "${SETUP_ARGS[@]}"

ok "Instance '$INSTANCE_ID' created."

# ── Step 6: Start and enable ─────────────────────────────
log "Step 6: Starting new instance..."
voicebridge start "$INSTANCE_ID"
ok "Instance started."

log "Step 7: Enabling auto-start on boot..."
voicebridge enable "$INSTANCE_ID"
ok "Instance enabled."

log "Step 8: Enabling linger for user '$USER'..."
sudo loginctl enable-linger "$USER" 2>/dev/null || warn "Could not enable-linger (may need root)"

# ── Done ─────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Migration Complete!"
echo "=========================================="
echo ""
echo "  New instance:    $INSTANCE_ID"
echo "  Backup:          $BACKUP_DIR"
echo ""
echo "Quick commands:"
echo "  voicebridge status $INSTANCE_ID"
echo "  voicebridge logs $INSTANCE_ID -f"
echo "  voicebridge list"
echo ""
echo "If something goes wrong, restore from backup:"
echo "  cp -r $BACKUP_DIR $OLD_PROJECT_DIR"
echo ""
