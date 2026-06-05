/**
 * Google Voice Monitor — watches voice.google.com for incoming calls
 */

import type { Page } from 'playwright';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';
import type { CallInfo, VoiceConfig, VoiceEvent } from '../types';

export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return digits.length > 0 ? `+${digits}` : '';
}

export function isAuthorized(call: CallInfo, config: VoiceConfig | null): boolean {
  if (!config) return false;
  if (config.authorizedNumbers.length > 0 && config.authorizedNumbers.includes(call.phoneNumber)) return true;
  if (config.authorizedNames && config.authorizedNames.length > 0 && call.callerName) {
    const lowerName = call.callerName.toLowerCase();
    for (const authName of config.authorizedNames) {
      if (authName && lowerName.includes(authName.toLowerCase())) return true;
    }
  }
  return false;
}

export class VoiceMonitor {
  private inCall: boolean;
  private currentCall: CallInfo | null;
  private polling: boolean;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private handlers: Map<VoiceEvent, Function[]>;
  private page: Page | null;
  private config: VoiceConfig | null;
  private pollMutex: boolean;
  private logger: Logger;
  private firstDetectionDump: boolean;

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
    this.firstDetectionDump = false;
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

  async startMonitoring(page: Page, config: VoiceConfig): Promise<void> {
    if (this.polling) throw new Error('Monitoring is already active');
    this.page = page;
    this.config = { pollInterval: 1000, ...config };
    this.polling = true;
    this.inCall = false;
    this.currentCall = null;
    this.firstDetectionDump = false;
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
    this.config = null;
    this.inCall = false;
    this.currentCall = null;
    this.logger.info('Stopped monitoring');
  }

  private async poll(): Promise<void> {
    if (this.pollMutex || !this.polling || !this.page || !this.config) return;
    this.pollMutex = true;
    try {
      if (!this.inCall) {
        const callInfo = await this.detectIncomingCall();
        if (callInfo) {
          this.logger.info(`Incoming call from ${callInfo.callerName || 'Unknown'} (${callInfo.phoneNumber})`);
          this.currentCall = callInfo;
          this.emit('incomingCall', callInfo);
          if (isAuthorized(callInfo, this.config)) {
            this.logger.info(`ALLOWED — ${callInfo.phoneNumber} is authorized`);
            if (this.config.autoAccept) {
              await this.acceptCall();
              this.inCall = true;
              this.emit('callAccepted', callInfo);
              this.logger.info(`Call accepted from ${callInfo.phoneNumber}`);
            }
          } else {
            this.logger.info(`DENIED — ${callInfo.phoneNumber} is NOT authorized`);
            await this.declineCall();
            this.currentCall = null;
          }
        }
      } else {
        const ended = await this.checkCallEnded();
        if (ended) {
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

  private async detectIncomingCall(): Promise<CallInfo | null> {
    if (!this.page) return null;
    const uiVisible = await this.isCallUIVisible();
    if (!uiVisible) {
      this.firstDetectionDump = false;
      return null;
    }
    if (!this.firstDetectionDump) {
      this.firstDetectionDump = true;
      await this.dumpCallDebugInfo();
    }
    return this.extractCallerInfo();
  }

  private async dumpCallDebugInfo(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.screenshot({ path: '/tmp/gv-incoming-call.png', fullPage: false });
      this.logger.info('Screenshot saved to /tmp/gv-incoming-call.png');

      const popupElements = await this.page.evaluate(() => {
        // @ts-expect-error document in browser evaluate
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const nodes: any[] = [];
        let node;
        while ((node = walker.nextNode()) !== null) {
          if ((node.textContent || '').includes('Incoming call')) {
            let el: any = node.parentElement;
            for (let i = 0; i < 6 && el; i++) {
              el = el.parentElement;
            }
            if (el) {
              const btns = Array.from(el.querySelectorAll('button, [role="button"], div[role="button"], mat-icon-button, mdc-icon-button')).map((b: any) => ({
                tag: b.tagName,
                text: (b.textContent || '').trim().substring(0, 60),
                ariaLabel: b.getAttribute('aria-label') || '',
                className: (b.className || '').toString().substring(0, 120),
                id: b.id || '',
                dataTestId: b.getAttribute('data-testid') || '',
                gvTestId: b.getAttribute('gv-test-id') || '',
              }));
              nodes.push({
                containerTag: el.tagName,
                containerClass: (el.className || '').toString().substring(0, 100),
                containerText: (el.textContent || '').trim().substring(0, 200),
                buttons: btns,
              });
            }
          }
        }
        return nodes;
      });

      const fs = require('fs');
      fs.writeFileSync('/tmp/gv-popup-elements.json', JSON.stringify(popupElements, null, 2));
      this.logger.info('Debug dump saved: /tmp/gv-popup-elements.json');
    } catch (e) {
      this.logger.warn('Failed to dump call debug info', { error: String(e) });
    }
  }

  private async isCallUIVisible(): Promise<boolean> {
    if (!this.page) return false;
    try {
      // Active call wrapper (present during ringing AND during connected call)
      if ((await this.page.locator('[class*="active-call-wrapper"]').count()) > 0) return true;

      // Incoming call specific container
      if ((await this.page.locator('div[gv-test-id="incoming-call"]').count()) > 0) return true;

      // Pickup/answer button
      if ((await this.page.locator('[gv-test-id="in-call-pickup-call"]').count()) > 0) return true;

      // End/decline button
      if ((await this.page.locator('[gv-test-id="in-call-end-call"]').count()) > 0) return true;

      return false;
    } catch {
      return false;
    }
  }

  private async extractCallerInfo(): Promise<CallInfo | null> {
    if (!this.page) return null;

    const result = await this.page.evaluate(() => {
      // Strategy 1: Look inside the active call wrapper
      // @ts-expect-error document in browser evaluate
      const activeWrapper = document.querySelector('[class*="active-call-wrapper"]');
      if (activeWrapper) {
        const text = activeWrapper.innerText || '';
        const patterns = [
          /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            return { rawNumber: match[0], callerName: '', source: 'active-wrapper' };
          }
        }
      }

      // Strategy 2: Look inside the incoming call popup container
      // @ts-expect-error document in browser evaluate
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode()) !== null) {
        if ((node.textContent || '').includes('Incoming call')) {
          let el: any = node.parentElement;
          for (let i = 0; i < 6 && el; i++) {
            el = el.parentElement;
          }
          if (el) {
            const text = el.innerText || '';
            const patterns = [
              /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
              /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
            ];
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                return { rawNumber: match[0], callerName: '', source: 'popup-container' };
              }
            }
          }
        }
      }

      // Strategy 3: gv-test-id element
      // @ts-expect-error document in browser evaluate
      const incomingCallEl = document.querySelector('div[gv-test-id="incoming-call"]');
      if (incomingCallEl) {
        const text = incomingCallEl.innerText || '';
        const patterns = [
          /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) return { rawNumber: match[0], callerName: '', source: 'incoming-call-el' };
        }
      }

      return null;
    });

    if (!result) return null;
    return {
      phoneNumber: normalizePhoneNumber(result.rawNumber),
      callerName: result.callerName,
      timestamp: new Date(),
    };
  }

  async acceptCall(): Promise<void> {
    if (!this.page) return;
    this.logger.info('Trying to accept call');

    // Primary: exact gv-test-id from DOM capture
    const primarySelectors = [
      '[gv-test-id="in-call-pickup-call"]',
      'button[aria-label="Answer call"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = this.page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          this.logger.info('Clicked answer button (primary selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // Fallbacks
    const fallbackSelectors = [
      'button:has-text("Answer")',
      'button[aria-label*="Answer" i]',
      'button:has-text("Accept")',
      'button[aria-label*="Accept" i]',
      'div[role="button"]:has-text("Answer")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = this.page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          this.logger.info('Clicked answer button (fallback selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }
    this.logger.warn('Could not find answer button to click');
  }

  async declineCall(): Promise<void> {
    if (!this.page) return;
    // Primary: exact gv-test-id from DOM capture
    const primarySelectors = [
      '[gv-test-id="in-call-end-call"]',
      'button[aria-label="Hang up call"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = this.page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          this.logger.info('Clicked decline button (primary selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }

    // Fallbacks
    const fallbackSelectors = [
      'button:has-text("Decline")',
      'button[aria-label*="Decline" i]',
      'button:has-text("Reject")',
      'button[aria-label*="Reject" i]',
      'div[role="button"]:has-text("Decline")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = this.page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          this.logger.info('Clicked decline button (fallback selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }
    this.logger.warn('Could not find decline button to click');
  }

  private async checkCallEnded(): Promise<boolean> {
    if (!this.page) return true;
    try {
      // If active call wrapper is gone AND no pickup/end buttons, call truly ended
      const hasActiveWrapper = (await this.page.locator('[class*="active-call-wrapper"]').count()) > 0;
      const hasPickupBtn = (await this.page.locator('[gv-test-id="in-call-pickup-call"]').count()) > 0;
      const hasEndBtn = (await this.page.locator('[gv-test-id="in-call-end-call"]').count()) > 0;

      if (!hasActiveWrapper && !hasPickupBtn && !hasEndBtn) {
        return true;
      }
      return false;
    } catch {
      return true;
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
