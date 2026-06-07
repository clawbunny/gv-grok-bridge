#!/bin/bash
# start.sh — Legacy manual start script.
#
# For multi-instance management, use the CLI instead:
#   voicebridge setup
#   voicebridge start <instance-id>
#   voicebridge list
#
# This script starts a single legacy instance using env vars.

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
echo "[START] Starting GV Bridge (legacy mode)..."
echo "        Headless: ${GV_HEADLESS:-true}"
echo "        Display:  ${GV_DISPLAY_NUM:-:99}"
echo ""
echo "[TIP] For multi-instance mode, run: voicebridge setup"
echo ""

node dist/main.js
