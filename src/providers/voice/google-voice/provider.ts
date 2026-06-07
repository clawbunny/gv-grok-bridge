/**
 * Google Voice Provider — implements VoiceProvider for voice.google.com
 */

import type { Page } from 'playwright';
import type { Logger } from '../../../logger';
import type { CallInfo } from '../../../types';
import type { VoiceProvider } from '../../contracts';

export class GoogleVoiceProvider implements VoiceProvider {
  readonly id = 'google-voice';
  readonly name = 'Google Voice';
  readonly url = 'https://voice.google.com';
  readonly origin = 'https://voice.google.com';

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    try {
      await page.context().grantPermissions(['microphone'], { origin: this.origin });
      logger.debug('Microphone permission granted for Google Voice');
    } catch (err) {
      logger.warn('Failed to grant microphone permissions', { error: (err as Error).message });
    }

    const isLoggedIn = await this.checkLoggedIn(page, logger);
    logger.info(`Google Voice initialization complete. Logged in: ${isLoggedIn}`);
    return isLoggedIn;
  }

  async checkLoggedIn(page: Page, logger: Logger): Promise<boolean> {
    const url = page.url();
    const loggedIn = url.includes('voice.google.com') && !url.includes('accounts.google.com');
    logger.debug(`Google Voice login check: ${loggedIn} (url: ${url})`);
    return loggedIn;
  }

  async detectIncomingCall(page: Page, logger: Logger): Promise<CallInfo | null> {
    const uiVisible = await this.isCallUIVisible(page);
    if (!uiVisible) return null;
    return this.extractCallerInfo(page, logger);
  }

  async acceptCall(page: Page, logger: Logger): Promise<void> {
    logger.info('Trying to accept call');

    const primarySelectors = [
      '[gv-test-id="in-call-pickup-call"]',
      'button[aria-label="Answer call"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          logger.info('Clicked answer button (primary selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }

    const fallbackSelectors = [
      'button:has-text("Answer")',
      'button[aria-label*="Answer" i]',
      'button:has-text("Accept")',
      'button[aria-label*="Accept" i]',
      'div[role="button"]:has-text("Answer")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          logger.info('Clicked answer button (fallback selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }
    logger.warn('Could not find answer button to click');
  }

  async declineCall(page: Page, logger: Logger): Promise<void> {
    const primarySelectors = [
      '[gv-test-id="in-call-end-call"]',
      'button[aria-label="Hang up call"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          logger.info('Clicked decline button (primary selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }

    const fallbackSelectors = [
      'button:has-text("Decline")',
      'button[aria-label*="Decline" i]',
      'button:has-text("Reject")',
      'button[aria-label*="Reject" i]',
      'div[role="button"]:has-text("Decline")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click();
          logger.info('Clicked decline button (fallback selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }
    logger.warn('Could not find decline button to click');
  }

  async isCallActive(page: Page, _logger: Logger): Promise<boolean> {
    try {
      const hasActiveWrapper = (await page.locator('[class*="active-call-wrapper"]').count()) > 0;
      const hasPickupBtn = (await page.locator('[gv-test-id="in-call-pickup-call"]').count()) > 0;
      const hasEndBtn = (await page.locator('[gv-test-id="in-call-end-call"]').count()) > 0;
      return hasActiveWrapper || hasPickupBtn || hasEndBtn;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────

  private async isCallUIVisible(page: Page): Promise<boolean> {
    try {
      if ((await page.locator('[class*="active-call-wrapper"]').count()) > 0) return true;
      if ((await page.locator('div[gv-test-id="incoming-call"]').count()) > 0) return true;
      if ((await page.locator('[gv-test-id="in-call-pickup-call"]').count()) > 0) return true;
      if ((await page.locator('[gv-test-id="in-call-end-call"]').count()) > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  private async extractCallerInfo(page: Page, logger: Logger): Promise<CallInfo | null> {
    const result = await page.evaluate(() => {
      const activeWrapper = document.querySelector('[class*="active-call-wrapper"]');
      if (activeWrapper) {
        const text = (activeWrapper as HTMLElement).innerText || '';
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

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
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

      const incomingCallEl = document.querySelector('div[gv-test-id="incoming-call"]');
      if (incomingCallEl) {
        const text = (incomingCallEl as HTMLElement).innerText || '';
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
}

export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return digits.length > 0 ? `+${digits}` : '';
}

export function isAuthorized(call: CallInfo, authorizedNumbers: string[], authorizedNames?: string[]): boolean {
  if (authorizedNumbers.length > 0 && authorizedNumbers.includes(call.phoneNumber)) return true;
  if (authorizedNames && authorizedNames.length > 0 && call.callerName) {
    const lowerName = call.callerName.toLowerCase();
    for (const authName of authorizedNames) {
      if (authName && lowerName.includes(authName.toLowerCase())) return true;
    }
  }
  return false;
}
