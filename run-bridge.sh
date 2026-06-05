#!/bin/bash
# Run the GV-Grok Bridge
set -e

export GV_AUTHORIZED_NUMBERS="${GV_AUTHORIZED_NUMBERS:-}"
export GV_AUTHORIZED_NAMES="${GV_AUTHORIZED_NAMES:-}"
export GV_HEADLESS="${GV_HEADLESS:-true}"
export GV_DISPLAY_NUM="${GV_DISPLAY_NUM:-:99}"
export GV_AUTO_ACCEPT="${GV_AUTO_ACCEPT:-true}"
export GV_LOG_LEVEL="${GV_LOG_LEVEL:-info}"

# Ensure PulseAudio is running
if ! pactl info >/dev/null 2>&1; then
  echo "[INFO] Starting PulseAudio..."
  pulseaudio --start
  sleep 1
fi

# Ensure dist exists
if [ ! -d "dist" ]; then
  echo "[BUILD] Building TypeScript..."
  npm run build
fi

echo "[START] Starting GV-Grok Bridge..."
echo "        Headless: $GV_HEADLESS"
echo "        Display:  $GV_DISPLAY_NUM"
echo ""

node dist/main.js
