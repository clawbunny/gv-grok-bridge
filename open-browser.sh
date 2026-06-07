#!/bin/bash
# Open system Chromium to log in to Google Voice and Grok
# Uses the same system binary that the bridge now uses
export DISPLAY=${DISPLAY:-:3}
chromium \
  --no-sandbox \
  --disable-gpu \
  --user-data-dir="${HOME}/.config/chromium" \
  --new-window \
  https://voice.google.com \
  https://grok.com &
