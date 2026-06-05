# How to Log In to Google Voice and Grok

## Step 1: Connect to VNC

The gvgrok user has a VNC desktop running on display :3 (port 5903).

From your local machine, create an SSH tunnel:
```bash
ssh -i ~/.ssh/martin_dsd_890_be -L 5903:localhost:5903 martin@dsd.890.be
```

Then connect with any VNC viewer to:
- Address: `localhost:5903`
- Password: `<VNC_PASSWORD>`

## Step 2: Open Chromium and Log In

Inside the VNC desktop, open a terminal and run:
```bash
cd ~/project
./open-browser.sh
```

This opens Chromium with two tabs:
1. https://voice.google.com  -> Log in with your Google account
2. https://grok.com          -> Log in with your x.ai account

## Step 3: Close Chromium

After logging in to BOTH services, **close Chromium completely**.
The bridge needs the profile to be unlocked.

## Step 4: Configure Authorized Numbers

Set which callers are allowed:
```bash
export GV_AUTHORIZED_NUMBERS="+12125551234,+13035556789"
export GV_AUTHORIZED_NAMES="Alice,Bob"
```

## Step 5: Run the Bridge
```bash
cd ~/project
./run-bridge.sh
```

The bridge will:
1. Set up PulseAudio virtual audio devices
2. Launch two Chromium instances (GV + Grok)
3. Monitor for incoming calls
4. Auto-answer authorized callers
5. Bridge audio to Grok AI voice mode

## Stopping the Bridge

Press `Ctrl+C` to stop gracefully.

## VNC Password Change

To change the VNC password:
```bash
vncpasswd
```
Then restart VNC:
```bash
vncserver -kill :3
vncserver :3 -geometry 1280x800 -depth 24 -localhost yes
```
