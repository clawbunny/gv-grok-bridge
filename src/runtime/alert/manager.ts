/**
 * AlertManager — detects critical failures and sends email alerts.
 *
 * Critical failures are issues that prevent the bridge from functioning
 * and will not auto-recover (e.g., voice provider not logged in).
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type { BridgeStatus } from '../../types';
import type { Logger } from '../../logger';

export type CriticalIssue =
  | 'not_running'
  | 'voice_not_logged_in'
  | 'ai_not_logged_in'
  | 'voice_browser_not_ready'
  | 'ai_browser_not_ready'
  | 'audio_not_ready';

export interface AlertConfig {
  instanceId: string;
  logDir: string;
}

export class AlertManager {
  private readonly statePath: string;
  private readonly minIntervalMs: number;
  private issueDescriptions: Record<CriticalIssue, string> = {
    not_running: 'Bridge is not running',
    voice_not_logged_in: 'Voice provider not logged in — calls will not be detected or answered',
    ai_not_logged_in: 'AI provider not logged in — voice mode cannot be activated',
    voice_browser_not_ready: 'Voice browser is not ready',
    ai_browser_not_ready: 'AI browser is not ready',
    audio_not_ready: 'Audio pipeline is not ready',
  };

  constructor(
    private config: AlertConfig,
    private logger: Logger,
    private fsImpl: typeof fs = fs,
    private childProcessImpl: { exec: typeof exec } = { exec },
    private findSendmailFn: () => string | null = findSendmail,
  ) {
    this.statePath = path.join(config.logDir, `${config.instanceId}-alerts.json`);
    this.minIntervalMs = 60 * 60 * 1000; // 1 hour default cooldown
  }

  /** Check status for critical issues and send alerts if configured. */
  checkAndAlert(status: BridgeStatus, alertEmail?: string): void {
    const issues = this.detectCriticalIssues(status);
    if (issues.length === 0 || !alertEmail) {
      this.clearResolvedIssues(issues);
      return;
    }

    const sendmailPath = this.findSendmailFn();
    if (!sendmailPath) {
      this.logger.warn('Alert email configured but sendmail not found. Install an MTA (e.g., postfix) to enable email alerts.');
      return;
    }

    const lastAlerts = this.readLastAlerts();
    const now = Date.now();
    const newLastAlerts: Record<string, number> = {};

    for (const issue of issues) {
      newLastAlerts[issue] = lastAlerts[issue] ?? now;
      if (!lastAlerts[issue] || now - lastAlerts[issue] >= this.minIntervalMs) {
        this.sendEmail(sendmailPath, issue, status, alertEmail).catch((err) => {
          this.logger.error('Failed to send alert email', { error: (err as Error).message });
        });
        newLastAlerts[issue] = now;
      }
    }

    this.writeLastAlerts(newLastAlerts);
  }

  /** Detect critical issues from bridge status. */
  detectCriticalIssues(status: BridgeStatus): CriticalIssue[] {
    const issues: CriticalIssue[] = [];
    if (!status.running) issues.push('not_running');
    if (!status.audioReady) issues.push('audio_not_ready');
    if (!status.voiceBrowserReady) issues.push('voice_browser_not_ready');
    if (!status.aiBrowserReady) issues.push('ai_browser_not_ready');
    if (!status.voiceLoggedIn) issues.push('voice_not_logged_in');
    if (!status.aiLoggedIn) issues.push('ai_not_logged_in');
    return issues;
  }

  /** Get human-readable description for an issue. */
  getIssueDescription(issue: CriticalIssue): string {
    return this.issueDescriptions[issue];
  }

  private async sendEmail(
    sendmailPath: string,
    issue: CriticalIssue,
    status: BridgeStatus,
    to: string,
  ): Promise<void> {
    const hostname = require('os').hostname();
    const subject = `[voicebridge] CRITICAL: ${this.config.instanceId} — ${issue}`;
    const body = this.buildEmailBody(issue, status, hostname, to);

    return new Promise((resolve, reject) => {
      const child = this.childProcessImpl.exec(
        `${sendmailPath} -i "${to}"`,
        { timeout: 30000 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
      child.stdin?.write(body);
      child.stdin?.end();
    });
  }

  private buildEmailBody(issue: CriticalIssue, status: BridgeStatus, hostname: string, to: string): string {
    const lines = [
      `To: ${to}`,
      `From: voicebridge@${hostname}`,
      `Subject: ${`[voicebridge] CRITICAL: ${this.config.instanceId} — ${issue}`}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'VoiceBridge Alert',
      '=================',
      '',
      `Instance: ${this.config.instanceId}`,
      `Host: ${hostname}`,
      `Time: ${new Date().toISOString()}`,
      `Issue: ${this.getIssueDescription(issue)}`,
      '',
      'Current Status:',
      `- Running: ${status.running}`,
      `- Audio Ready: ${status.audioReady}`,
      `- Voice Browser Ready: ${status.voiceBrowserReady}`,
      `- AI Browser Ready: ${status.aiBrowserReady}`,
      `- Voice Logged In: ${status.voiceLoggedIn}`,
      `- AI Logged In: ${status.aiLoggedIn}`,
      `- In Call: ${status.inCall}`,
      '',
      'This alert was sent because a critical failure was detected.',
      'The service will not work correctly until this issue is resolved.',
      '',
    ];
    return lines.join('\n');
  }

  private readLastAlerts(): Record<string, number> {
    try {
      const raw = this.fsImpl.readFileSync(this.statePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeLastAlerts(state: Record<string, number>): void {
    try {
      if (!this.fsImpl.existsSync(path.dirname(this.statePath))) {
        this.fsImpl.mkdirSync(path.dirname(this.statePath), { recursive: true });
      }
      this.fsImpl.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.error('Failed to write alert state', { error: (err as Error).message });
    }
  }

  private clearResolvedIssues(currentIssues: CriticalIssue[]): void {
    try {
      if (!this.fsImpl.existsSync(this.statePath)) return;
      const lastAlerts = this.readLastAlerts();
      const cleared: Record<string, number> = {};
      for (const issue of currentIssues) {
        if (lastAlerts[issue]) cleared[issue] = lastAlerts[issue];
      }
      this.writeLastAlerts(cleared);
    } catch {
      // ignore
    }
  }
}

function findSendmail(): string | null {
  const candidates = ['/usr/sbin/sendmail', '/usr/bin/sendmail'];
  for (const p of candidates) {
    try {
      require('fs').accessSync(p, require('fs').constants.X_OK);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}
