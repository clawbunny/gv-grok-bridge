#!/bin/bash
# GV-Grok Bridge status banner
# Install to /etc/update-motd.d/99-gv-grok-bridge

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo "=========================================="
echo "     GV-Grok Bridge — Status & Help"
echo "=========================================="

# Check bridge process
BRIDGE_PID=$(pgrep -u gvgrok -f 'node dist/main.js' | head -1)
if [ -n "$BRIDGE_PID" ]; then
    echo -e "${GREEN}● Bridge is RUNNING${NC} (PID: $BRIDGE_PID)"
else
    echo -e "${RED}● Bridge is STOPPED${NC}"
fi

# Check Chromium processes
CHROME_COUNT=$(pgrep -u gvgrok -c -f 'chromium' 2>/dev/null || echo 0)
if [ "$CHROME_COUNT" -gt 0 ]; then
    echo -e "${GREEN}  Chromium processes: $CHROME_COUNT${NC}"
else
    echo -e "${YELLOW}  No Chromium processes${NC}"
fi

# Check PulseAudio devices
echo ""
echo "PulseAudio virtual devices:"
if command -v pactl >/dev/null 2>&1; then
    sudo -u gvgrok pactl list sinks short 2>/dev/null | grep -E 'pipe_gv_to_grok|pipe_grok_to_gv' | while read line; do
        echo "  $line"
    done
else
    echo "  (PulseAudio not available)"
fi

# Recent log tail
echo ""
echo "Recent log entries:"
if [ -f /home/gvgrok/project/bridge.log ]; then
    tail -n 4 /home/gvgrok/project/bridge.log 2>/dev/null | sed 's/^/  /'
else
    echo "  (No log file found)"
fi

# Quick commands
echo ""
echo "Quick commands:"
echo "  Start bridge:      sudo systemctl start gv-grok-bridge"
echo "  Stop bridge:       sudo systemctl stop gv-grok-bridge"
echo "  View logs:         sudo tail -f /home/gvgrok/project/bridge.log"
echo "  Restart bridge:    sudo systemctl restart gv-grok-bridge"
echo "  Check status:      sudo systemctl status gv-grok-bridge"
echo "  Check audio:       sudo -u gvgrok pactl list sources short"
echo "  VNC desktop:       ssh -L 5903:localhost:5903 $(whoami)@$(hostname -f)"
echo "                     VNC password: <VNC_PASSWORD>"

echo ""
echo "=========================================="
echo ""
