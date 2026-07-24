#!/bin/bash
# Open Chromium with the bridge-compatible password store so login state
# can be read by the headless Playwright browser used by the service.
export DISPLAY=${DISPLAY:-:3}
chromium \
  --no-sandbox \
  --disable-gpu \
  --password-store=basic \
  --use-mock-keychain \
  --user-data-dir="${HOME}/.config/chromium" \
  --new-window \
  https://voice.google.com \
  https://grok.com &
