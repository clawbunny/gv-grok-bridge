#!/bin/bash
# build-dist.sh — Create a release tarball for distribution.
#
# Usage:
#   ./scripts/build-dist.sh [version]
# Output: dist/voicebridge-<version>.tar.gz

set -e

VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo 'dev')}"
OUTPUT_DIR="dist"
TARBALL="$OUTPUT_DIR/voicebridge-${VERSION}.tar.gz"
TEMP_DIR=$(mktemp -d)
STAGE_DIR="$TEMP_DIR/voicebridge-$VERSION"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${BLUE}[dist]${NC} $1"; }
ok()  { echo -e "${GREEN}[dist]${NC} $1"; }

log "Building release $VERSION..."

# ── Ensure built ─────────────────────────────────────────
if [ ! -d "dist" ]; then
  log "Building TypeScript first..."
  node node_modules/typescript/bin/tsc
fi

# ── Stage files ──────────────────────────────────────────
mkdir -p "$STAGE_DIR"

cp -r dist "$STAGE_DIR/"
cp -r bin "$STAGE_DIR/"
cp package.json package-lock.json "$STAGE_DIR/"
cp setup.sh start.sh run-bridge.sh motd.sh "$STAGE_DIR/"
cp -r templates "$STAGE_DIR/" 2>/dev/null || true
cp gv-grok-bridge.service "$STAGE_DIR/"
cp README.md "$STAGE_DIR/"
cp -r docs "$STAGE_DIR/" 2>/dev/null || true
cp Makefile "$STAGE_DIR/"
cp -r scripts "$STAGE_DIR/"

# ── Create tarball ───────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
tar -czf "$TARBALL" -C "$TEMP_DIR" "voicebridge-$VERSION"

# ── Clean up ─────────────────────────────────────────────
rm -rf "$TEMP_DIR"

ok "Release created: $TARBALL"
echo ""
echo "Install on a target machine:"
echo "  tar -xzf $TARBALL"
echo "  cd voicebridge-$VERSION"
echo "  sudo make install"
echo ""
