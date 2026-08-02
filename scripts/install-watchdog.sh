#!/usr/bin/env bash
# Install the gv-bridge heartbeat watchdog as a systemd user timer.
#
# Usage:
#   ./scripts/install-watchdog.sh
#
# Configure the alert channel afterwards by editing the generated
# ~/.config/systemd/user/gv-bridge-watchdog.service and setting either
#   Environment="GV_WATCHDOG_MAIL_CMD=msmtp -t"   (needs msmtp configured)
# or
#   Environment="GV_WATCHDOG_WEBHOOK=https://..."
# then: systemctl --user daemon-reload && systemctl --user restart gv-bridge-watchdog.timer
set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${UNIT_DIR}"

cat > "${UNIT_DIR}/gv-bridge-watchdog.service" <<EOF
[Unit]
Description=GV Bridge heartbeat watchdog

[Service]
Type=oneshot
Environment="GV_WATCHDOG_TO=gvgrok@pivetta.be"
# Pick ONE alert channel and uncomment:
#Environment="GV_WATCHDOG_MAIL_CMD=msmtp -t"
#Environment="GV_WATCHDOG_WEBHOOK=https://example.invalid/hook"
ExecStart=/usr/bin/node ${SCRIPT_DIR}/scripts/watchdog.cjs
EOF

cat > "${UNIT_DIR}/gv-bridge-watchdog.timer" <<'EOF'
[Unit]
Description=GV Bridge heartbeat watchdog (every minute)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now gv-bridge-watchdog.timer

echo "Watchdog timer installed and started."
echo "Check: systemctl --user list-timers gv-bridge-watchdog.timer"
echo "Logs:  journalctl --user -u gv-bridge-watchdog.service -n 20"
