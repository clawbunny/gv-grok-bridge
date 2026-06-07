#!/bin/bash
# GV Bridge — MOTD status banner
# Install to /etc/update-motd.d/99-voicebridge for login messages.
#
# Usage (as root):
#   sudo cp motd.sh /etc/update-motd.d/99-voicebridge
#   sudo chmod +x /etc/update-motd.d/99-voicebridge

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo "=========================================="
echo "     GV Bridge — Instance Status"
echo "=========================================="

# Check for instances in all user home directories
TOTAL_INSTANCES=0
ACTIVE_INSTANCES=0
INACTIVE_INSTANCES=0

# Collect instance info from all users with systemd user services
for user_dir in /home/*; do
  if [ ! -d "$user_dir/.config/systemd/user" ]; then
    continue
  fi
  user=$(basename "$user_dir")
  for svc in "$user_dir/.config/systemd/user"/gv-bridge-*.service; do
    [ -f "$svc" ] || continue
    instance=$(basename "$svc" .service | sed 's/gv-bridge-//')
    TOTAL_INSTANCES=$((TOTAL_INSTANCES + 1))
    status=$(su - "$user" -c "systemctl --user is-active gv-bridge-${instance} 2>/dev/null" || echo "inactive")
    if [ "$status" = "active" ]; then
      ACTIVE_INSTANCES=$((ACTIVE_INSTANCES + 1))
      echo -e "  ${GREEN}●${NC} ${instance} (user: ${user})"
    else
      INACTIVE_INSTANCES=$((INACTIVE_INSTANCES + 1))
      echo -e "  ${RED}●${NC} ${instance} (user: ${user}) — stopped"
    fi
  done
done

if [ "$TOTAL_INSTANCES" -eq 0 ]; then
  echo "  No instances configured."
  echo ""
  echo "  To get started:"
  echo "    voicebridge setup"
fi

echo ""
echo "Quick commands:"
echo "  List instances:    voicebridge list"
echo "  Start instance:    voicebridge start <id>"
echo "  Stop instance:     voicebridge stop <id>"
echo "  View logs:         voicebridge logs <id> -f"
echo "  Check status:      voicebridge status <id>"
echo "  Create instance:   voicebridge setup"
echo ""
echo "=========================================="
echo ""
