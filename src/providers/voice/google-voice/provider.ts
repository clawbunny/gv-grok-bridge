/**
 * Google Voice Provider — implements VoiceProvider for voice.google.com
 */

import type { Page, BrowserContext } from 'playwright';
import type { Logger } from '../../../logger';
import type { CallInfo } from '../../../types';
import type { VoiceProvider } from '../../contracts';
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

export class GoogleVoiceProvider implements VoiceProvider {
  readonly id = 'google-voice';
  readonly name = 'Google Voice';
  readonly url = 'https://voice.google.com';
  readonly origin = 'https://voice.google.com';

  constructor(private cookiePath?: string) {}

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    const context = page.context() as BrowserContext;

    try {
      await context.grantPermissions(['microphone'], { origin: this.origin });
      logger.debug('Microphone permission granted for Google Voice');
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
    await this.dumpCallUI(page, logger);
    await this.dismissBlockingDialogs(page, logger);

    const selectors = [
      '[gv-test-id="in-call-pickup-call"]',
      'button[aria-label="Answer call"]',
      'button:has-text("Answer")',
      'button[aria-label*="Answer" i]',
      'button:has-text("Accept")',
      'button[aria-label*="Accept" i]',
      'div[role="button"]:has-text("Answer")',
    ];
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) === 0) continue;

        await locator.click({ timeout: 5000, force: true });
        logger.info(`Clicked answer button (${selector})`);

        // Verify the click really connected: a successful answer dismisses
        // the pickup button. A click that lands on an overlay "succeeds"
        // silently while the call keeps ringing — treat that as failure so
        // the caller-facing retry/decline logic kicks in.
        await page.waitForTimeout(1500);
        const stillRinging = (await page.locator('[gv-test-id="in-call-pickup-call"]').count()) > 0;
        if (!stillRinging) {
          logger.info('Answer verified — pickup button dismissed');
          return;
        }
        logger.warn(`Answer click on ${selector} did not connect — trying next selector`);
      } catch (err) {
        logger.warn(`Answer attempt via ${selector} failed: ${(err as Error).message}`);
      }
    }
    throw new Error('Could not find a working answer button');
  }

  /**
   * Dismiss modal dialogs/upsells that overlay the call UI and intercept
   * clicks (observed in production: a "Let Gemini take notes" modal with a
   * "Maybe later" button swallowed every answer click while the call rang
   * through to voicemail).
   */
  private async dismissBlockingDialogs(page: Page, logger: Logger): Promise<void> {
    const dismissSelectors = [
      '[role="dialog"] button:has-text("Maybe later")',
      'button:has-text("Maybe later")',
      '[role="dialog"] button:has-text("No thanks")',
      'button:has-text("No thanks")',
      '[role="dialog"] button:has-text("Got it")',
      'button:has-text("Got it")',
      '[role="dialog"] button:has-text("Dismiss")',
      '[role="dialog"] button[aria-label*="close" i]',
    ];
    for (let round = 0; round < 3; round++) {
      let dismissed = false;
      for (const sel of dismissSelectors) {
        try {
          const btn = page.locator(sel).first();
          if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
            await btn.click({ timeout: 3000, force: true });
            logger.info(`Dismissed blocking dialog via ${sel}`);
            await page.waitForTimeout(400);
            dismissed = true;
            break;
          }
        } catch {
          // try next selector
        }
      }
      if (!dismissed) return;
    }
  }

  /** Screenshot + button inventory of the call UI for post-mortem debugging. */
  private async dumpCallUI(page: Page, logger: Logger): Promise<void> {
    try {
      const dir = process.env.GV_DEBUG_DIR || '/tmp/gv-bridge-debug';
      fs.mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      await page.screenshot({ path: `${dir}/incoming-${ts}.png` });

      const dump = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((b) => (b as HTMLElement).offsetParent !== null)
          .slice(0, 40)
          .map((b) => ({
            testid: b.getAttribute('gv-test-id'),
            aria: b.getAttribute('aria-label'),
            text: (b.textContent || '').trim().slice(0, 30),
          }));
        const callEl =
          document.querySelector('div[gv-test-id="incoming-call"]') ||
          document.querySelector('[class*="active-call-wrapper"]');
        return {
          buttons,
          callHtml: callEl ? (callEl as HTMLElement).outerHTML.slice(0, 3000) : null,
        };
      });
      fs.writeFileSync(`${dir}/incoming-${ts}.json`, JSON.stringify(dump, null, 2));
      logger.info(`Call UI dumped to ${dir}/incoming-${ts}.{png,json}`);
    } catch (err) {
      logger.warn(`Call UI dump failed: ${(err as Error).message}`);
    }
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
          await locator.click({ timeout: 5000, force: true });
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
          await locator.click({ timeout: 5000, force: true });
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
