#!/bin/bash
# uninstall.sh — Completely remove GV Bridge from the system.
#
# Usage:
#   sudo ./scripts/uninstall.sh
#   sudo ./scripts/uninstall.sh /opt/voicebridge /usr/local/bin

set -e

INSTALL_DIR="${1:-/opt/voicebridge}"
BIN_DIR="${2:-/usr/local/bin}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[uninstall]${NC} $1"; }
ok()  { echo -e "${GREEN}[uninstall]${NC} $1"; }
warn() { echo -e "${YELLOW}[uninstall]${NC} $1"; }
err()  { echo -e "${RED}[uninstall]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
  err "Please run as root or with sudo:"
  err "  sudo ./scripts/uninstall.sh"
  exit 1
fi

# ── Confirm ──────────────────────────────────────────────
warn "This will remove:"
echo "  - $INSTALL_DIR"
echo "  - $BIN_DIR/voicebridge"
echo "  - $BIN_DIR/voicebridge-run"
echo "  - All systemd user services for all users"
echo ""
read -p "Are you sure? Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  log "Aborted."
  exit 0
fi

# ── Stop all instances for all users ─────────────────────
log "Stopping all bridge instances..."
for user_home in /home/* /root; do
  if [ -d "$user_home/.config/systemd/user" ]; then
    user_name=$(basename "$user_home")
    for service in "$user_home/.config/systemd/user"/gv-bridge-*.service; do
      [ -e "$service" ] || continue
      svc_name=$(basename "$service")
      log "  Stopping $svc_name for user $user_name..."
      su - "$user_name" -c "systemctl --user stop $svc_name" 2>/dev/null || true
      su - "$user_name" -c "systemctl --user disable $svc_name" 2>/dev/null || true
    done
  fi
done

# ── Remove system installation ───────────────────────────
if [ -d "$INSTALL_DIR" ]; then
  log "Removing $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
fi

if [ -L "$BIN_DIR/voicebridge" ]; then
  log "Removing $BIN_DIR/voicebridge..."
  rm -f "$BIN_DIR/voicebridge"
fi

if [ -L "$BIN_DIR/voicebridge-run" ]; then
  log "Removing $BIN_DIR/voicebridge-run..."
  rm -f "$BIN_DIR/voicebridge-run"
fi

# ── Ask about user data ──────────────────────────────────
echo ""
read -p "Remove all instance configs and data from user home directories? (y/N) " REMOVE_DATA
if [ "$REMOVE_DATA" = "y" ] || [ "$REMOVE_DATA" = "Y" ]; then
  log "Removing user data..."
  for user_home in /home/* /root; do
    if [ -d "$user_home" ]; then
      rm -rf "$user_home/.config/gv-bridge" 2>/dev/null || true
      rm -rf "$user_home/.local/share/gv-bridge" 2>/dev/null || true
      rm -rf "$user_home/.local/state/gv-bridge" 2>/dev/null || true
      rm -f "$user_home/.config/systemd/user/gv-bridge-*.service" 2>/dev/null || true
    fi
  done
  ok "User data removed."
else
  log "User data preserved."
  log "To remove manually later:"
  log "  rm -rf ~/.config/gv-bridge ~/.local/share/gv-bridge ~/.local/state/gv-bridge"
fi

# ── Reload systemd ───────────────────────────────────────
log "Reloading systemd daemon..."
systemctl daemon-reload 2>/dev/null || true

ok "Uninstall complete."
