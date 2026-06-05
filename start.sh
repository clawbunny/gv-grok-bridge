#!/bin/bash
# start.sh — Start the GV-Grok Bridge manually
#
# NOTE: For production, use systemd instead:
#   sudo systemctl start gv-grok-bridge
#   sudo systemctl status gv-grok-bridge
# This script is useful for development or debugging.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Ensure dist exists ──
if [ ! -d "dist" ]; then
  echo "[BUILD] Building TypeScript..."
  node node_modules/typescript/bin/tsc
fi

# ── Check PulseAudio ──
if ! pactl info &>/dev/null; then
  echo "[WARN] PulseAudio not running. Starting..."
  pulseaudio --start 2>/dev/null || {
    echo "[ERROR] Failed to start PulseAudio. Run: sudo apt install pulseaudio"
    exit 1
  }
  sleep 1
fi

# ── Check authorized numbers ──
if [ -z "$GV_AUTHORIZED_NUMBERS" ] && [ -z "$GV_AUTHORIZED_NAMES" ]; then
  echo "[WARN] No authorized numbers configured."
  echo "       Set GV_AUTHORIZED_NUMBERS=\"+12125551234,...\""
  echo "       Only authorized callers will be auto-accepted."
fi

# ── Kill lingering chromium ──
pkill -9 -f 'chromium' 2>/dev/null || true

# ── Start ──
echo "[START] Starting GV-Grok Bridge..."
echo "        Headless: ${GV_HEADLESS:-true}"
echo "        Display:  ${GV_DISPLAY_NUM:-:99}"
echo ""

node dist/main.js
