/**
 * Generic Voice Monitor — delegates all provider-specific logic to a VoiceProvider.
 * Handles polling, authorization, and event emission.
 *
 * Stability contract:
 * - Every poll cycle is bounded by `pollTimeout` (mutex is always released).
 * - Call acceptance is bounded by `acceptTimeoutMs`, retried `acceptRetries`
 *   times, and the call is declined + `acceptFailed` emitted when acceptance
 *   cannot be confirmed — a caller must never ring forever while we hang.
 * - Hung provider operations cannot be cancelled by Promise.race alone; the
 *   monitor emits `pollTimeout` so the orchestrator can recycle the page
 *   (closing the page rejects all outstanding Playwright calls).
 */

import type { Page } from 'playwright';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';
import type { CallInfo, VoiceEvent } from '../types';
import type { VoiceProvider } from '../providers/contracts';
import { isAuthorized } from '../providers/voice/google-voice/provider';

export interface MonitorConfig {
  authorizedNumbers: string[];
  authorizedNames?: string[];
  autoAccept: boolean;
  pollInterval?: number;
  /** Maximum time (ms) a single poll iteration may run before it is aborted. */
  pollTimeout?: number;
  /** Maximum time (ms) to wait for the accept-click to complete. */
  acceptTimeoutMs?: number;
  /** Number of accept retries after the first failure. */
  acceptRetries?: number;
}

const VOICE_EVENTS: VoiceEvent[] = [
  'incomingCall',
  'callAccepted',
  'callEnded',
  'acceptFailed',
  'pollTimeout',
  'error',
];

export class VoiceMonitor {
  private inCall: boolean;
  private currentCall: CallInfo | null;
  private polling: boolean;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private handlers: Map<VoiceEvent, Function[]>;
  private page: Page | null;
  private config: Required<MonitorConfig> | null;
  private pollMutex: boolean;
  private logger: Logger;
  private provider: VoiceProvider | null;

  constructor(logger: Logger = new SilentLogger()) {
    this.inCall = false;
    this.currentCall = null;
    this.polling = false;
    this.pollTimer = null;
    this.handlers = new Map<VoiceEvent, Function[]>();
    this.page = null;
    this.config = null;
    this.pollMutex = false;
    this.logger = logger;
    this.provider = null;
    for (const event of VOICE_EVENTS) {
      this.handlers.set(event, []);
    }
  }

  isInCall(): boolean { return this.inCall; }
  isMonitoring(): boolean { return this.polling; }
  getCurrentCall(): CallInfo | null { return this.currentCall; }

  on(event: VoiceEvent, handler: Function): void {
    this.handlers.get(event)?.push(handler);
  }

  async startMonitoring(page: Page, provider: VoiceProvider, config: MonitorConfig): Promise<void> {
    if (this.polling) throw new Error('Monitoring is already active');
    this.page = page;
    this.provider = provider;
    this.config = {
      pollInterval: 1000,
      pollTimeout: 15000,
      acceptTimeoutMs: 5000,
      acceptRetries: 1,
      authorizedNames: [],
      ...config,
    };
    this.polling = true;
    this.inCall = false;
    this.currentCall = null;
    const interval = this.config.pollInterval;
    this.logger.info(`Started monitoring (interval: ${interval}ms)`);
    await this.poll();
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error('Poll error', { message: error.message });
        this.emit('error', error);
      });
    }, interval);
  }

  async stopMonitoring(): Promise<void> {
    this.polling = false;
    if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.page = null;
    this.provider = null;
    this.config = null;
    this.inCall = false;
    this.currentCall = null;
    this.logger.info('Stopped monitoring');
  }

  private async poll(): Promise<void> {
    if (this.pollMutex || !this.polling || !this.page || !this.provider || !this.config) return;
    this.pollMutex = true;
    const timeoutMs = this.config.pollTimeout;
    let timedOut = false;
    try {
      await Promise.race([
        this.runPollCycle(),
        new Promise<void>((_, reject) => {
          const t = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Poll cycle timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Error during poll', { message: error.message });
      if (timedOut) this.emit('pollTimeout', error);
      this.emit('error', error);
    } finally {
      this.pollMutex = false;
    }
  }

  private async runPollCycle(): Promise<void> {
    if (!this.page || !this.provider || !this.config) return;
    if (!this.inCall) {
      const callInfo = await this.provider.detectIncomingCall(this.page, this.logger);
      if (callInfo) {
        this.logger.info(`Incoming call from ${callInfo.callerName || 'Unknown'} (${callInfo.phoneNumber})`);
        this.currentCall = callInfo;
        this.emit('incomingCall', callInfo);
        if (isAuthorized(callInfo, this.config.authorizedNumbers, this.config.authorizedNames)) {
          this.logger.info(`ALLOWED — ${callInfo.phoneNumber} is authorized`);
          if (this.config.autoAccept) {
            await this.acceptWithRetry(callInfo);
          }
        } else {
          this.logger.info(`DENIED — ${callInfo.phoneNumber} is NOT authorized`);
          await this.provider.declineCall(this.page, this.logger);
          this.currentCall = null;
        }
      }
    } else {
      const active = await this.provider.isCallActive(this.page, this.logger);
      if (!active) {
        this.logger.info('Call ended');
        this.inCall = false;
        this.currentCall = null;
        this.emit('callEnded');
      }
    }
  }

  /**
   * Accept the incoming call with a hard per-attempt timeout. If acceptance
   * cannot be confirmed after all retries, decline the call so the caller is
   * not left ringing, and emit `acceptFailed` for alerting.
   */
  private async acceptWithRetry(callInfo: CallInfo): Promise<void> {
    if (!this.page || !this.provider || !this.config) return;
    const attempts = 1 + this.config.acceptRetries;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.withTimeout(
          this.provider.acceptCall(this.page, this.logger),
          this.config.acceptTimeoutMs,
          `acceptCall timed out after ${this.config.acceptTimeoutMs}ms`,
        );
        this.inCall = true;
        this.emit('callAccepted', callInfo);
        this.logger.info(`Call accepted from ${callInfo.phoneNumber} (attempt ${attempt})`);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(`acceptCall failed (attempt ${attempt}/${attempts})`, { message: error.message });
      }
    }

    this.logger.error(`Accept failed for ${callInfo.phoneNumber} — declining call`);
    try {
      await this.withTimeout(
        this.provider.declineCall(this.page, this.logger),
        this.config.acceptTimeoutMs,
        'declineCall timed out',
      );
    } catch { /* best effort — caller will reach voicemail */ }
    this.currentCall = null;
    this.emit('acceptFailed', callInfo);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const t = setTimeout(() => reject(new Error(message)), timeoutMs);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
  }

  private emit(event: VoiceEvent, ...args: any[]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(...args); } catch (err) {
          this.logger.error(`Error in '${event}' handler`, { error: String(err) });
        }
      }
    }
  }
}
