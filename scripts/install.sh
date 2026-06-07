#!/bin/bash
# install.sh — Install GV Bridge to a system directory.
#
# Usage:
#   sudo ./scripts/install.sh                    # Install to defaults
#   sudo ./scripts/install.sh /opt/voicebridge /usr/local/bin
#
# This script can also be run standalone. If not inside the repo,
# it clones from GitHub first.

set -e

INSTALL_DIR="${1:-/opt/voicebridge}"
BIN_DIR="${2:-/usr/local/bin}"
REPO_URL="https://github.com/clawbunny/gv-grok-bridge.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[install]${NC} $1"; }
ok()  { echo -e "${GREEN}[install]${NC} $1"; }
warn() { echo -e "${YELLOW}[install]${NC} $1"; }
err()  { echo -e "${RED}[install]${NC} $1"; }

# ── Detect if we're inside the repo ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  BUILT_IN_PLACE=true
else
  BUILT_IN_PLACE=false
fi

# ── Check for old installation ───────────────────────────
OLD_SERVICE="gv-grok-bridge.service"
if systemctl is-active "$OLD_SERVICE" &>/dev/null || systemctl is-enabled "$OLD_SERVICE" &>/dev/null; then
  warn "Detected old gv-grok-bridge systemd service: $OLD_SERVICE"
  warn "The old single-instance bridge is not compatible with the new multi-instance voicebridge."
  echo ""
  echo "  To migrate automatically, run:"
  echo "    ./scripts/migrate.sh"
  echo ""
  echo "  To continue installing alongside (NOT recommended):"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Check OS ─────────────────────────────────────────────
if ! grep -q "Ubuntu\|Debian" /etc/os-release 2>/dev/null; then
  warn "This script is designed for Ubuntu/Debian."
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Need root for system install ─────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "Please run as root or with sudo:"
  err "  sudo ./scripts/install.sh"
  exit 1
fi

# ── Install system dependencies ──────────────────────────
log "Updating package list..."
apt-get update -qq

log "Installing PulseAudio..."
apt-get install -y -qq pulseaudio pulseaudio-utils

log "Installing Xvfb and Chromium dependencies..."
apt-get install -y -qq xvfb fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2

# ── Install Node.js 20+ ──────────────────────────────────
if ! command -v node &>/dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
  apt-get install -y -qq nodejs
fi
ok "Node.js $(node -v) installed."

# ── Get source ───────────────────────────────────────────
if [ "$BUILT_IN_PLACE" = true ]; then
  log "Installing from local source: $SOURCE_DIR"
  WORK_DIR="$SOURCE_DIR"
else
  log "Cloning from $REPO_URL..."
  WORK_DIR="/tmp/voicebridge-install-$$"
  rm -rf "$WORK_DIR"
  git clone --depth 1 "$REPO_URL" "$WORK_DIR"
fi

# ── Install npm deps and build ───────────────────────────
cd "$WORK_DIR"
log "Installing npm dependencies (including dev deps for build)..."
npm install

log "Installing Playwright Chromium..."
npx playwright install chromium 2>/dev/null || true
npx playwright install-deps chromium 2>/dev/null || true

log "Building TypeScript..."
node node_modules/typescript/bin/tsc

# ── Copy to system location ──────────────────────────────
log "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# Copy only what's needed for runtime
cp -r dist "$INSTALL_DIR/"
cp -r bin "$INSTALL_DIR/"
cp package.json package-lock.json "$INSTALL_DIR/"
cp setup.sh start.sh run-bridge.sh motd.sh "$INSTALL_DIR/" 2>/dev/null || true
cp -r templates "$INSTALL_DIR/" 2>/dev/null || true
cp gv-grok-bridge.service "$INSTALL_DIR/" 2>/dev/null || true
cp README.md "$INSTALL_DIR/" 2>/dev/null || true
cp -r docs "$INSTALL_DIR/" 2>/dev/null || true

# Re-install production deps in target location (skip devDeps)
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund

# ── Symlink binaries ─────────────────────────────────────
log "Linking commands to $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/voicebridge" "$BIN_DIR/voicebridge"
ln -sf "$INSTALL_DIR/bin/voicebridge-run" "$BIN_DIR/voicebridge-run"
chmod +x "$INSTALL_DIR/bin/voicebridge"
chmod +x "$INSTALL_DIR/bin/voicebridge-run"

# ── Set permissions ──────────────────────────────────────
chown -R root:root "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR/bin"/*

# ── Clean up temp clone ──────────────────────────────────
if [ "$BUILT_IN_PLACE" = false ]; then
  rm -rf "$WORK_DIR"
fi

# ── Done ─────────────────────────────────────────────────
ok "Installation complete!"
echo ""
echo "=========================================="
echo "  GV Bridge Installed"
echo "=========================================="
echo ""
echo "  Location:   $INSTALL_DIR"
echo "  Commands:   $BIN_DIR/voicebridge"
echo "              $BIN_DIR/voicebridge-run"
echo ""
echo "Next steps:"
echo ""
echo "1. Log in to providers in Chromium:"
echo "   - https://voice.google.com"
echo "   - https://grok.com"
echo ""
echo "2. Create an instance:"
echo "   voicebridge setup"
echo ""
echo "3. Enable auto-start before login:"
echo "   loginctl enable-linger \$USER"
echo "   voicebridge enable <instance-id>"
echo ""
echo "4. For each user that needs instances:"
echo "   sudo usermod -aG audio,pulse \$USER"
echo ""
echo "   Note: some systems also have a 'pulse-access' group."
echo "   If audio devices are not visible, also try:"
echo "   sudo usermod -aG pulse-access \$USER"
echo ""
