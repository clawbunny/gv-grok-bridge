/**
 * TextNow Voice Provider — implements VoiceProvider for www.textnow.com
 */

import type { Page, BrowserContext } from 'playwright';
import type { Logger } from '../../../logger';
import type { CallInfo } from '../../../types';
import type { VoiceProvider } from '../../contracts';
import { normalizePhoneNumber } from '../google-voice/provider';
import * as fs from 'fs';

interface CookieEntry {
  domain: string;
  name: string;
  value: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number | string;
}

export class TextNowVoiceProvider implements VoiceProvider {
  readonly id = 'textnow';
  readonly name = 'TextNow';
  readonly url = 'https://www.textnow.com/messaging';
  readonly origin = 'https://www.textnow.com';

  constructor(private cookiePath?: string) {}

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    const context = page.context() as BrowserContext;

    try {
      await context.grantPermissions(['microphone'], { origin: this.origin });
      logger.debug('Microphone permission granted for TextNow');
    } catch (err) {
      logger.warn('Failed to grant microphone permissions', { error: (err as Error).message });
    }

    if (this.cookiePath && fs.existsSync(this.cookiePath)) {
      try {
        await this.loadCookies(context, logger);
      } catch (err) {
        logger.warn('Failed to load cookies', { error: (err as Error).message });
      }
    }

    try {
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      logger.warn('Navigation to TextNow messaging timed out or failed', { error: (err as Error).message });
    }

    const isLoggedIn = await this.checkLoggedIn(page, logger);
    logger.info(`TextNow initialization complete. Logged in: ${isLoggedIn}`);
    return isLoggedIn;
  }

  async checkLoggedIn(page: Page, logger: Logger): Promise<boolean> {
    const url = page.url();
    const loggedIn = url.includes('textnow.com') && !url.includes('/login') && !url.includes('/signin');
    logger.debug(`TextNow login check: ${loggedIn} (url: ${url})`);
    return loggedIn;
  }

  async detectIncomingCall(page: Page, logger: Logger): Promise<CallInfo | null> {
    const uiVisible = await this.isCallUIVisible(page);
    if (!uiVisible) return null;
    return this.extractCallerInfo(page, logger);
  }

  async acceptCall(page: Page, logger: Logger): Promise<void> {
    logger.info('Trying to accept call');

    // Try JavaScript direct click first — most reliable for TextNow's div-based buttons
    try {
      const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('.new-dialog-container.incoming-call');
        if (!dialog) return false;
        // Try explicit accept button classes
        let btn = dialog.querySelector('.button.accept.primary') as HTMLElement | null;
        if (!btn) btn = dialog.querySelector('.button.accept') as HTMLElement | null;
        // Try any image with alt="Accept" and walk up to clickable parent
        if (!btn) {
          const img = dialog.querySelector('img[alt="Accept"]') as HTMLElement | null;
          if (img) {
            let el: HTMLElement | null = img;
            while (el && el !== dialog) {
              if (el.classList.contains('button') || el.tagName === 'BUTTON') {
                btn = el;
                break;
              }
              el = el.parentElement as HTMLElement | null;
            }
          }
        }
        if (btn) {
          // Use dispatchEvent with a proper MouseEvent to trigger React synthetic handlers
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          btn.dispatchEvent(event);
          // Also fire the native click as a fallback
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        logger.info('Clicked answer button via JavaScript');
        return;
      }
    } catch (err) {
      logger.warn('JavaScript accept click failed', { error: (err as Error).message });
    }

    // Fallback to Playwright locators
    const primarySelectors = [
      '.new-dialog-container.incoming-call .button.accept',
      '.button.accept.primary',
      'button[aria-label="Answer call"]',
      'button[aria-label="Answer"]',
      '[data-testid="answer-button"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click({ timeout: 5000 });
          logger.info('Clicked answer button (primary selector)');
          return;
        }
      } catch {
        // Try next selector
      }
    }

    const fallbackSelectors = [
      'button:has-text("Accept")',
      'button[aria-label*="Accept" i]',
      'button:has-text("Answer")',
      'button[aria-label*="Answer" i]',
      'div[role="button"]:has-text("Accept")',
      'div[role="button"]:has-text("Answer")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click({ timeout: 5000 });
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
    logger.info('Trying to decline call');

    // Try JavaScript direct click first
    try {
      const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('.new-dialog-container.incoming-call');
        if (!dialog) return false;
        let btn = dialog.querySelector('#no-btn') as HTMLElement | null;
        if (!btn) btn = dialog.querySelector('.button.decline.secondary') as HTMLElement | null;
        if (!btn) btn = dialog.querySelector('.button.decline') as HTMLElement | null;
        if (!btn) {
          const img = dialog.querySelector('img[alt="Decline"]') as HTMLElement | null;
          if (img) {
            let el: HTMLElement | null = img;
            while (el && el !== dialog) {
              if (el.classList.contains('button') || el.tagName === 'BUTTON') {
                btn = el;
                break;
              }
              el = el.parentElement as HTMLElement | null;
            }
          }
        }
        if (btn) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          btn.dispatchEvent(event);
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        logger.info('Clicked decline button via JavaScript');
        return;
      }
    } catch (err) {
      logger.warn('JavaScript decline click failed', { error: (err as Error).message });
    }

    const primarySelectors = [
      '#no-btn',
      '.button.decline.secondary',
      'button[aria-label="Hang up call"]',
      'button[aria-label="End call"]',
      'button[aria-label="Decline"]',
      '[data-testid="decline-button"]',
      '[data-testid="end-call-button"]',
    ];
    for (const selector of primarySelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click({ timeout: 5000 });
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
      'button:has-text("End call")',
      'button[aria-label*="End call" i]',
      'div[role="button"]:has-text("Decline")',
    ];
    for (const selector of fallbackSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click({ timeout: 5000 });
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
      // The incoming-call dialog is only present during an active/ringing call.
      // Once the call ends or goes to voicemail, it disappears.
      const hasIncomingDialog = (await page.locator('.new-dialog-container.incoming-call').count()) > 0;
      if (hasIncomingDialog) return true;

      // Check for active in-call UI elements that indicate an ongoing conversation.
      // These selectors must be specific to active calls, not permanent page elements.
      const hasActiveWrapper = (await page.locator('[class*="active-call"]').count()) > 0;
      const hasInCall = (await page.locator('[class*="in-call"]').count()) > 0;
      const hasCallPanel = (await page.locator('[class*="call-panel"]').count()) > 0;
      return hasActiveWrapper || hasInCall || hasCallPanel;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────

  private async loadCookies(context: BrowserContext, logger: Logger): Promise<void> {
    if (!this.cookiePath) return;
    const raw = fs.readFileSync(this.cookiePath, 'utf-8');
    const data = JSON.parse(raw);
    const cookies: CookieEntry[] = data.cookies || [];

    const formatted = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires && c.expires > 0 ? Math.floor((c.expires - 11644473600000000) / 1000000) : -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: typeof c.sameSite === 'number' ? this.mapSameSite(c.sameSite) : (c.sameSite as 'Strict' | 'Lax' | 'None' | undefined),
    }));

    await context.addCookies(formatted);
    logger.info(`Loaded ${formatted.length} cookies into browser context`);
  }

  private mapSameSite(sameSite: number): 'Strict' | 'Lax' | 'None' | undefined {
    switch (sameSite) {
      case 0: return 'None';
      case 1: return 'Lax';
      case 2: return 'Strict';
      default: return undefined;
    }
  }

  private async isCallUIVisible(page: Page): Promise<boolean> {
    try {
      if ((await page.locator('.new-dialog-container.incoming-call').count()) > 0) return true;
      if ((await page.locator('[class*="active-call"]').count()) > 0) return true;
      if ((await page.locator('[class*="incoming-call"]').count()) > 0) return true;
      if ((await page.locator('[class*="call-panel"]').count()) > 0) return true;
      if ((await page.locator('button[aria-label*="Answer"]').count()) > 0) return true;
      if ((await page.locator('button:has-text("Answer")').count()) > 0) return true;
      if ((await page.locator('button:has-text("Accept")').count()) > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  private async extractCallerInfo(page: Page, logger: Logger): Promise<CallInfo | null> {
    const result = await page.evaluate(() => {
      // If the TextNow incoming call dialog is present, we know there's a call.
      // Search the entire page for a phone number.
      const incomingDialog = document.querySelector('.new-dialog-container.incoming-call');
      if (incomingDialog) {
        const bodyText = document.body.innerText || '';
        const patterns = [
          /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\b\d{10}\b/,
        ];
        for (const pattern of patterns) {
          const match = bodyText.match(pattern);
          if (match) {
            return { rawNumber: match[0], callerName: '', source: 'page-body' };
          }
        }
        // No number found on page, but dialog is present — still a call
        return { rawNumber: '', callerName: '', source: 'incoming-dialog' };
      }

      // Try active call wrapper
      const activeWrapper = document.querySelector('[class*="active-call"]');
      if (activeWrapper) {
        const text = (activeWrapper as HTMLElement).innerText || '';
        const patterns = [
          /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            return { rawNumber: match[0], callerName: '', source: 'active-call' };
          }
        }
      }

      // Try incoming call popup/container via text walker
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode()) !== null) {
        const textContent = (node.textContent || '').toLowerCase();
        if (textContent.includes('incoming call')) {
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

      // Try any element containing a phone number near answer/decline/accept buttons
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], .button.accept, .button.decline'));
      const hasAnswer = buttons.some((b) => {
        const label = ((b as HTMLElement).innerText || b.getAttribute('aria-label') || '').toLowerCase();
        return label.includes('answer') || label.includes('accept') || label.includes('decline');
      });
      if (hasAnswer) {
        const bodyText = document.body.innerText;
        const patterns = [
          /\+1\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
          /\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/,
        ];
        for (const pattern of patterns) {
          const match = bodyText.match(pattern);
          if (match) {
            return { rawNumber: match[0], callerName: '', source: 'body-text' };
          }
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
