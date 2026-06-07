# How to Log In to Your Providers

Before the bridge can handle calls, you must be logged in to both your voice provider (e.g. Google Voice) and your AI provider (e.g. Grok) in Chromium.

## Prerequisites

- GV Bridge is installed (`voicebridge` command is available)
- Chromium is installed on the system

## Step 1: Open Chromium

Run Chromium with your default profile:

```bash
chromium
```

If you are running headless on a remote server, you may need to use X11 forwarding or a VNC desktop:

```bash
# X11 forwarding over SSH
ssh -X your-server
chromium
```

Or set up a VNC desktop if X11 forwarding is not available.

## Step 2: Log In to Both Services

1. Navigate to **https://voice.google.com** and log in with your Google account.
2. Open a new tab and navigate to **https://grok.com** and log in with your x.ai account.

## Step 3: Close Chromium

After logging in to **BOTH** services, **close Chromium completely**.

The bridge needs the profile to be unlocked so it can launch its own Chromium instances.

## Step 4: Create and Start a Bridge Instance

```bash
# Interactive setup wizard
voicebridge setup

# Or specify everything on the command line
voicebridge setup -i my-bridge -v google-voice -a grok -n "+12125551234"

# Start the instance
voicebridge start my-bridge
```

## Step 5: Verify It Is Working

```bash
# Check status
voicebridge status my-bridge

# Follow the logs
voicebridge logs my-bridge -f
```

## Troubleshooting

**"Not logged in" errors in logs:**
- Re-open Chromium and verify you are still logged in.
- Close Chromium before restarting the bridge.

**"Profile in use" errors:**
- Make sure no other Chromium processes are running.
- The install script and service file automatically kill lingering Chromium processes before starting.

**Audio issues:**
- Check your user is in the `audio` and `pulse` groups.
- Verify PulseAudio is running: `pulseaudio --check || pulseaudio --start`
