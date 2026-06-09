# Authentication Workflow

Both the **voice provider** (e.g., Google Voice) and the **AI provider** (e.g., Grok) require an active browser session. This guide covers how to establish and maintain those sessions.

## Overview

The bridge launches its own Chromium instances but reuses your **default profile** (`~/.config/chromium`) for the voice browser and a **copy** of that profile for the AI browser. If you are logged into your providers in the default profile, the bridge inherits those sessions.

## Quick Check

```bash
voicebridge status <instance-id>
```

Look for:
- `Voice Logged In: ✓ yes`
- `AI Logged In: ✓ yes`

If either is `✗ no`, follow the workflow below.

---

## Method 1: Direct Browser Login (Recommended)

### 1. Stop the bridge

**Important:** The bridge startup kills all Chromium processes. Stop it first so your manual login isn't wiped.

```bash
voicebridge stop <instance-id>
```

### 2. Open Chromium with the bridge profile

**On the server (if you have physical or remote X access):**

```bash
# If the server has an X display
sudo -u <instance-user> bash -c 'DISPLAY=:1 chromium --user-data-dir=/home/<instance-user>/.config/chromium'

# Or use xvfb-run if no real display is available
sudo -u <instance-user> xvfb-run --auto-servernum chromium --user-data-dir=/home/<instance-user>/.config/chromium
```

**From your Mac (via X11 forwarding):**

```bash
ssh -X <user>@<server>
sudo -E -u <instance-user> chromium --user-data-dir=/home/<instance-user>/.config/chromium
```

### 3. Log in to each provider

1. Navigate to `https://accounts.google.com` and sign in
2. Navigate to `https://voice.google.com` and verify the actual Voice interface loads (not the marketing page)
3. Navigate to `https://grok.com` and sign in there as well

### 4. Close Chromium properly

Use **Ctrl+Q** or **File → Exit**. Do not just close the terminal or kill the process — cookies may not flush to disk.

### 5. Start the bridge

```bash
voicebridge start <instance-id>
```

Wait ~20 seconds, then verify:

```bash
voicebridge status <instance-id>
```

---

## Method 2: Cookie Import (Cross-Device)

If you cannot log in directly on the bridge server (e.g., headless VPS, no X access), export cookies from a browser where you are already logged in.

### Google Voice Cookie Import

Add to your instance config:

```yaml
voiceProvider:
  type: google-voice
  config:
    cookiePath: /home/<user>/.config/gv-bridge/gv-cookies.json
```

### TextNow Cookie Import

```yaml
voiceProvider:
  type: textnow
  config:
    cookiePath: /home/<user>/.config/gv-bridge/textnow-cookies.json
```

### Exporting Cookies from macOS Chrome

Use the `export-cookies.py` script at the project root:

```bash
# Export Google cookies
python3 export-cookies.py --domain google.com --output gv-cookies.json

# The script reads from ~/Library/Application Support/Google/Chrome/Default/Cookies
# and decrypts them using the Chrome Safe Storage key from macOS Keychain.
```

**Requirements:**
- `pip3 install cryptography`
- You must be signed into Google in Chrome on your Mac

Transfer the JSON to the server and restart the instance.

---

## Troubleshooting

### "Voice Logged In: no" after login

1. **Check the profile path** in your instance config matches where you logged in
2. **Check for redirects** — `voicebridge status` shows the actual URL; if it is `workspace.google.com/products/voice/`, the session is not valid
3. **Wait and retry** — Google may require a second verification step on first launch
4. **Enable debug logging** to see the exact URL:
   ```bash
   voicebridge config <instance-id>  # set logLevel: debug
   voicebridge restart <instance-id>
   voicebridge logs <instance-id> -f | grep "login check"
   ```

### Session expires after ~24 hours

Google sessions expire periodically. When `voicebridge status` shows a critical issue and you receive an alert email, repeat Method 1 above.

### AI provider "not logged in"

Grok's login is less strict — usually just requires a valid `grok.com` session in the same profile. If it fails, open the AI browser directly and log in:

```bash
sudo -u <user> bash -c 'DISPLAY=:1 chromium --user-data-dir=/tmp/gv-bridge/<instance-id>/chromium-copy'
```

Then log in at `https://grok.com`.
