# GV Bridge — Makefile for build, install, test, and distribution

PREFIX ?= /usr/local
INSTALL_DIR ?= /opt/voicebridge
BIN_DIR ?= $(PREFIX)/bin

.PHONY: all build install uninstall test lint clean dist help

all: build

build:
	@echo "[BUILD] Compiling TypeScript..."
	@node node_modules/typescript/bin/tsc

test:
	@echo "[TEST] Running test suite..."
	@node node_modules/jest/bin/jest.js --verbose

test-watch:
	@node node_modules/jest/bin/jest.js --watch

test-coverage:
	@node node_modules/jest/bin/jest.js --coverage

lint:
	@echo "[LINT] Type-checking..."
	@node node_modules/typescript/bin/tsc --noEmit

install:
	@echo "[INSTALL] Installing GV Bridge..."
	@bash scripts/install.sh "$(INSTALL_DIR)" "$(BIN_DIR)"

uninstall:
	@echo "[UNINSTALL] Removing GV Bridge..."
	@bash scripts/uninstall.sh "$(INSTALL_DIR)" "$(BIN_DIR)"

dist:
	@echo "[DIST] Creating release tarball..."
	@bash scripts/build-dist.sh

clean:
	@echo "[CLEAN] Removing dist/ and coverage/..."
	@rm -rf dist coverage

help:
	@echo "GV Bridge — Available targets:"
	@echo "  make build       — Compile TypeScript"
	@echo "  make test        — Run test suite"
	@echo "  make lint        — Type-check without emit"
	@echo "  make install     — Install to system (default: /opt/voicebridge)"
	@echo "  make uninstall   — Remove from system"
	@echo "  make dist        — Build release tarball"
	@echo "  make clean       — Remove build artifacts"
	@echo "  make help        — Show this message"
	@echo ""
	@echo "Install locations can be overridden:"
	@echo "  make install INSTALL_DIR=/opt/voicebridge BIN_DIR=/usr/local/bin"
