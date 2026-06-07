/**
 * Generic Voice Monitor — delegates all provider-specific logic to a VoiceProvider.
 * Handles polling, authorization, and event emission.
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
}

export class VoiceMonitor {
  private inCall: boolean;
  private currentCall: CallInfo | null;
  private polling: boolean;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private handlers: Map<VoiceEvent, Function[]>;
  private page: Page | null;
  private config: MonitorConfig | null;
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
    for (const event of ['incomingCall', 'callAccepted', 'callEnded', 'error'] as VoiceEvent[]) {
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
    this.config = { pollInterval: 1000, ...config };
    this.polling = true;
    this.inCall = false;
    this.currentCall = null;
    const interval = this.config.pollInterval ?? 1000;
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
    try {
      if (!this.inCall) {
        const callInfo = await this.provider.detectIncomingCall(this.page, this.logger);
        if (callInfo) {
          this.logger.info(`Incoming call from ${callInfo.callerName || 'Unknown'} (${callInfo.phoneNumber})`);
          this.currentCall = callInfo;
          this.emit('incomingCall', callInfo);
          if (isAuthorized(callInfo, this.config.authorizedNumbers, this.config.authorizedNames)) {
            this.logger.info(`ALLOWED — ${callInfo.phoneNumber} is authorized`);
            if (this.config.autoAccept) {
              await this.provider.acceptCall(this.page, this.logger);
              this.inCall = true;
              this.emit('callAccepted', callInfo);
              this.logger.info(`Call accepted from ${callInfo.phoneNumber}`);
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Error during poll', { message: error.message });
      this.emit('error', error);
    } finally {
      this.pollMutex = false;
    }
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
