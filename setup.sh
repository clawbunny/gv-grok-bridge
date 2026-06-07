#!/bin/bash
# setup.sh — One-time Ubuntu setup for GV Bridge
#
# This script is a convenience wrapper around scripts/install.sh.
# For full control, run: sudo ./scripts/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/install.sh"
