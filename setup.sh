#!/bin/bash
# setup.sh — One-time Ubuntu setup for GV-Grok Bridge

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="gv-grok-bridge"
MOTD_SCRIPT="/etc/update-motd.d/99-gv-grok-bridge"

echo "=========================================="
echo "  GV-Grok Bridge — Ubuntu Setup"
echo "=========================================="
echo ""

# ── Check Ubuntu/Debian ──
if ! grep -q "Ubuntu\|Debian" /etc/os-release 2>/dev/null; then
  echo "WARNING: This script is designed for Ubuntu/Debian."
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Create gvgrok user if not exists ──
if ! id -u gvgrok &>/dev/null; then
  echo "[1/8] Creating gvgrok user..."
  sudo useradd -m -s /bin/bash gvgrok
else
  echo "[1/8] User gvgrok already exists"
fi

# ── Update packages ──
echo "[2/8] Updating package list..."
sudo apt-get update -qq

# ── Install PulseAudio ──
echo "[3/8] Installing PulseAudio..."
sudo apt-get install -y -qq pulseaudio pulseaudio-utils

# ── Install Xvfb and Chromium dependencies ──
echo "[4/8] Installing Xvfb and Chromium dependencies..."
sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2

# ── Install Node.js 20+ ──
echo "[5/8] Installing Node.js 20..."
if ! command -v node &>/dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - &>/dev/null
  sudo apt-get install -y -qq nodejs
fi
echo "       Node.js version: $(node -v)"

# ── Install Playwright Chromium ──
echo "[6/8] Installing Playwright Chromium..."
cd "$SCRIPT_DIR"
npm install --no-bin-links 2>/dev/null
npx playwright install chromium 2>/dev/null || true
npx playwright install-deps chromium 2>/dev/null || true

# ── Create temp profile directory ──
echo "[7/8] Creating temp profile directory..."
mkdir -p /tmp/gv-grok-bridge/chromium-copy
sudo chown -R gvgrok:gvgrok /tmp/gv-grok-bridge

# ── Install systemd service ──
echo "[8/8] Installing systemd service..."
sudo cp "$SCRIPT_DIR/$SERVICE_NAME.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

# ── Enable user lingering for gvgrok (needed for XDG_RUNTIME_DIR at boot) ──
echo "       Enabling user lingering for gvgrok..."
sudo loginctl enable-linger gvgrok

# ── Install MOTD ──
echo "       Installing MOTD..."
sudo cp "$SCRIPT_DIR/motd.sh" "$MOTD_SCRIPT"
sudo chmod +x "$MOTD_SCRIPT"

# ── Done ──
echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Make sure you're LOGGED IN to:"
echo "   - https://voice.google.com (in your default Chromium profile)"
echo "   - https://grok.com (in your default Chromium profile)"
echo ""
echo "2. Set authorized phone numbers in the service file:"
echo "   sudo systemctl edit --full $SERVICE_NAME"
echo "   (Edit the GV_AUTHORIZED_NUMBERS environment variable)"
echo ""
echo "3. Build and start the bridge:"
echo "   cd /home/gvgrok/project && npm run build"
echo "   sudo systemctl start $SERVICE_NAME"
echo ""
echo "4. Enable auto-start on reboot (already enabled):"
echo "   sudo systemctl is-enabled $SERVICE_NAME"
echo ""
echo "Quick commands:"
echo "   sudo systemctl start $SERVICE_NAME   # Start now"
echo "   sudo systemctl stop $SERVICE_NAME    # Stop"
echo "   sudo systemctl status $SERVICE_NAME  # Check status"
echo "   sudo tail -f /home/gvgrok/project/bridge.log"
echo ""
