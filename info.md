# Research Notes — Google Voice ↔ Grok Bridge

## Google Voice (voice.google.com)

### DOM Structure for Incoming Calls
- Google Voice is an Angular 1.x SPA (lots of `ng-*` attributes)
- Incoming call UI appears as an overlay/modal
- **Key selectors to try** (order of preference):
  1. `div[gv-test-id="incoming-call"]` — most reliable if present
  2. `div[ng-if="ctrl.isIncomingCall()"]` or similar Angular expressions
  3. Text-based: `div:has-text("Incoming call")`, `div:has-text("incoming")`
  4. Buttons: `button:has-text("Answer")`, `button:has-text("Decline")`
  5. `div[data-e2e="incoming-call"]` — possible e2e test attributes
  6. `[aria-label*="Incoming call"]` — accessibility labels
  7. General: look for sudden appearance of answer/decline button pairs

### Call State Detection Strategy
- **Poll-based**: every 1-2s, use `page.evaluate()` to query DOM
- **Multi-strategy**: Try selector 1, if not found try 2, etc.
- **Button pair detection**: Look for any "Answer" + "Decline" buttons appearing simultaneously
- **Caller ID extraction**: Look for phone number pattern `+1 (\d{3}) \d{3}-\d{4}` or `\d{3}-\d{3}-\d{4}` in text content

### Authentication Check
- Navigate to `https://voice.google.com`
- If redirected to `accounts.google.com` → not logged in
- If page shows "Google Voice" UI → logged in
- Check for GV-specific elements: left sidebar, "Calls" tab, etc.

### Phone Number Normalization
- Input: `+1 (212) 555-1234` or `212-555-1234` or `(212) 555-1234`
- Output E.164: `+12125551234`
- Strip all non-digits, add +1 if 10 digits

---

## Grok (grok.com)

### Voice/Speak Mode
- Grok has a voice mode accessible via microphone button
- The mic button is typically near the chat input area
- **Selectors to try**:
  1. `button[aria-label*="microphone"]` 
  2. `button[aria-label*="voice"]`
  3. `svg[data-testid="mic-icon"]` or similar
  4. Button with mic SVG icon inside
  5. `button:has(svg)` near textarea
  6. Keyboard shortcut: may exist but undocumented

### Authentication Check
- Navigate to `https://grok.com`
- Check for login button: `button:has-text("Log in")` or `a[href*="login"]`
- If chat input textarea is visible → logged in
- Grok uses x.ai auth (may have separate session from Google)

### Microphone Permission
- Must call `context.grantPermissions(['microphone'], {origin: 'https://grok.com'})`
- Uses WebRTC `getUserMedia()` for audio capture
- The virtual PulseAudio source feeds into WebRTC automatically

---

## PulseAudio Command Reference

### Setup
```bash
# Create null sinks (float32le prevents s16le clipping from WebRTC AGC)
pactl load-module module-null-sink sink_name=pipe_gv_to_grok format=float32le sink_properties="device.description='GV_Out_to_Grok_In'"
pactl load-module module-null-sink sink_name=pipe_grok_to_gv format=float32le sink_properties="device.description='Grok_Out_to_GV_In'"

# Create remap sources from monitor
pactl load-module module-remap-source master=pipe_gv_to_grok.monitor source_name=src_gv_to_grok source_properties="device.description='GV_Audio_to_Grok_Mic'"
pactl load-module module-remap-source master=pipe_grok_to_gv.monitor source_name=src_grok_to_gv source_properties="device.description='Grok_Audio_to_GV_Mic'"

# Set volumes to 70% to create AGC headroom
pactl set-sink-volume pipe_gv_to_grok 45875
pactl set-sink-volume pipe_grok_to_gv 45875
```

### Per-Browser Environment
```bash
# GV Browser
PULSE_SINK=pipe_gv_to_grok PULSE_SOURCE=src_grok_to_gv PULSE_PROP_application.name=Chromium-GV chromium ...

# Grok Browser  
PULSE_SINK=pipe_grok_to_gv PULSE_SOURCE=src_gv_to_grok PULSE_PROP_application.name=Chromium-Grok chromium ...
```

### Teardown
```bash
pactl unload-module <module_id>
```

### Verification
```bash
pactl list sinks | grep -A5 "pipe_"
pactl list sources | grep -A5 "src_"
```

---

## Playwright Notes

### Persistent Context
```javascript
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: '/usr/lib/chromium/chromium',
  headless: false,  // Use xvfb instead
  args: [
    '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
    '--use-fake-ui-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  env: {
    PULSE_SINK: 'pipe_gv_to_grok',
    PULSE_SOURCE: 'src_grok_to_gv',
    PULSE_PROP_application_name: 'Chromium-GV',
    DISPLAY: ':99',
  }
});
```

### Mic Permission
```javascript
await context.grantPermissions(['microphone'], { origin: 'https://voice.google.com' });
await context.grantPermissions(['microphone'], { origin: 'https://grok.com' });
```

---

## Xvfb for Headless

```bash
# Start Xvfb
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &

# Run browser with DISPLAY=:99
DISPLAY=:99 chromium ...
```

## Minimal Ubuntu Package List
```
pulseaudio
pulseaudio-utils
xvfb
chromium-browser (or install via playwright)
nodejs
npm
```
