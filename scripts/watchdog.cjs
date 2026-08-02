#!/usr/bin/env node
/**
 * gv-bridge heartbeat watchdog.
 *
 * Runs every minute via a systemd user timer. For every configured bridge
 * instance it checks:
 *   1. status.json exists and is fresh (< STALE_AFTER_MS) — the bridge writes
 *      it on every 10 s health tick, so a stale file means the bridge is wedged.
 *   2. status.json criticalIssues is empty.
 *   3. calls.jsonl has no recent accept_failed / silent_ai_audio records.
 *
 * Alerts are deduplicated: one email/webhook POST when an issue set appears,
 * one recovery notice when it clears. State lives in watchdog-state.json.
 *
 * Alert channels (first configured wins):
 *   GV_WATCHDOG_WEBHOOK   — POST JSON {"text": "..."} via curl
 *   GV_WATCHDOG_MAIL_CMD  — shell command accepting a full RFC822 message on
 *                           stdin, e.g. GV_WATCHDOG_MAIL_CMD="msmtp -t"
 *   If neither is set, the alert is printed to stdout (journal) only.
 *
 * Env:
 *   GV_WATCHDOG_TO        — recipient address (default: instance alertEmail or gvgrok@pivetta.be)
 *   GV_WATCHDOG_FROM      — sender address (default: gv-bridge-watchdog@<hostname>)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'gv-bridge', 'instances');
const STATE_DIR = path.join(HOME, '.local', 'state', 'gv-bridge');
const STATE_FILE = path.join(STATE_DIR, 'watchdog-state.json');

const STALE_AFTER_MS = 90 * 1000;
const CALL_ISSUE_WINDOW_MS = 15 * 60 * 1000;
const CALL_ISSUE_REASONS = ['accept_failed', 'silent_ai_audio'];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function listInstances() {
  try {
    return fs.readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function checkInstance(instanceId) {
  const issues = [];
  const dir = path.join(STATE_DIR, 'instances', instanceId);
  const statusPath = path.join(dir, 'status.json');

  let stat = null;
  try { stat = fs.statSync(statusPath); } catch { /* missing */ }
  if (!stat) {
    issues.push('status_missing: status.json not found');
  } else {
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_AFTER_MS) {
      issues.push(`status_stale: last update ${Math.round(ageMs / 1000)}s ago`);
    }
    const status = readJson(statusPath);
    if (status && Array.isArray(status.criticalIssues)) {
      for (const issue of status.criticalIssues) issues.push(issue);
    }
  }

  // Recent call-level failures
  const callsPath = path.join(dir, 'calls.jsonl');
  try {
    const stat2 = fs.statSync(callsPath);
    if (Date.now() - stat2.mtimeMs < CALL_ISSUE_WINDOW_MS) {
      const lines = fs.readFileSync(callsPath, 'utf-8').trim().split('\n').slice(-50);
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const when = Date.parse(rec.endedAt || rec.detectedAt || '');
        if (Number.isNaN(when) || Date.now() - when > CALL_ISSUE_WINDOW_MS) continue;
        if (rec.endReason && CALL_ISSUE_REASONS.includes(rec.endReason)) {
          issues.push(`call_${rec.endReason}: ${rec.phoneNumber} at ${rec.endedAt}`);
        }
        if (rec.silentAiAudio) {
          issues.push(`call_silent_ai_audio: ${rec.phoneNumber} at ${rec.endedAt}`);
        }
      }
    }
  } catch { /* no calls file yet */ }

  return issues;
}

function loadState() {
  return readJson(STATE_FILE) || {};
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

function sendAlert(subject, body) {
  const webhook = process.env.GV_WATCHDOG_WEBHOOK;
  const mailCmd = process.env.GV_WATCHDOG_MAIL_CMD;
  const to = process.env.GV_WATCHDOG_TO || 'gvgrok@pivetta.be';
  const from = process.env.GV_WATCHDOG_FROM || `gv-bridge-watchdog@${os.hostname()}`;

  if (webhook) {
    try {
      const payload = JSON.stringify({ text: `${subject}\n\n${body}` });
      execFileSync('curl', ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', payload, webhook], { timeout: 15000 });
      log(`alert sent via webhook: ${subject}`);
      return;
    } catch (err) {
      log(`webhook alert failed: ${err.message}`);
    }
  }

  if (mailCmd) {
    try {
      const message = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
      ].join('\n');
      execSync(mailCmd, { input: message, timeout: 20000 });
      log(`alert sent via mail command: ${subject}`);
      return;
    } catch (err) {
      log(`mail command failed: ${err.message}`);
    }
  }

  if (!webhook && !mailCmd) {
    log(`ALERT (no channel configured): ${subject}\n${body}`);
  }
}

function main() {
  const instances = listInstances();
  if (instances.length === 0) {
    log('no instances configured — nothing to check');
    return;
  }

  const state = loadState();
  let changed = false;

  for (const instanceId of instances) {
    const issues = checkInstance(instanceId);
    const key = issues.slice().sort().join('|');
    const prev = state[instanceId];

    if (issues.length > 0 && prev !== key) {
      const subject = `[gv-bridge] ${instanceId}: ${issues.length} issue(s) detected`;
      const body = [
        `Instance: ${instanceId}`,
        `Host: ${os.hostname()}`,
        `Time: ${new Date().toISOString()}`,
        '',
        'Issues:',
        ...issues.map((i) => `  - ${i}`),
        '',
        'Inspect:',
        `  journalctl --user -u gv-bridge-${instanceId} -n 100`,
        `  cat ~/.local/state/gv-bridge/instances/${instanceId}/status.json`,
      ].join('\n');
      sendAlert(subject, body);
      state[instanceId] = key;
      changed = true;
    } else if (issues.length === 0 && prev) {
      sendAlert(`[gv-bridge] ${instanceId}: recovered`, 'All watchdog checks are green again.');
      delete state[instanceId];
      changed = true;
    }
  }

  if (changed) saveState(state);
  log(`checked ${instances.length} instance(s)`);
}

main();
