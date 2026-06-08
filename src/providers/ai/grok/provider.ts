/**
 * Grok Provider — implements AIProvider for grok.com
 */

import type { Page } from 'playwright';
import type { Logger } from '../../../logger';
import type { AIProvider } from '../../contracts';

export class GrokProvider implements AIProvider {
  readonly id = 'grok';
  readonly name = 'Grok';
  readonly url = 'https://grok.com';
  readonly origin = 'https://grok.com';

  private voiceModeActive = false;

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    try {
      await page.context().grantPermissions(['microphone'], { origin: this.origin });
      logger.debug('Microphone permission granted for grok.com');
    } catch (err) {
      logger.warn('Failed to grant microphone permissions', { error: (err as Error).message });
    }

    const isLoggedIn = await this.checkLoggedIn(page, logger);
    logger.info(`Grok initialization complete. Logged in: ${isLoggedIn}`);
    return isLoggedIn;
  }

  async checkLoggedIn(page: Page, logger: Logger): Promise<boolean> {
    try {
      const currentUrl = page.url();
      if (!currentUrl.includes('grok.com')) {
        logger.debug('Navigating to grok.com...');
        await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      await page.waitForTimeout(10000);
      const url = page.url();

      const loginSelectors = [
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'a:has-text("Log in")',
        'a:has-text("Sign in")',
        '[data-testid="login-button"]',
        'button[aria-label*="login" i]',
      ];
      for (const sel of loginSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) {
            logger.debug('Login button found on grok.com');
            return false;
          }
        }
      }

      const chatSelectors = [
        'textarea',
        'div[contenteditable="true"]',
        '[data-testid="message-input"]',
        'input[placeholder*="Ask" i]',
        'input[placeholder*="help you" i]',
        'input[placeholder*="Message" i]',
        'div[role="textbox"]',
        'input[type="text"]',
        'input:not([type])',
      ];
      for (const sel of chatSelectors) {
        const input = page.locator(sel).first();
        if ((await input.count()) > 0) {
          logger.debug('Chat input found on grok.com');
          return true;
        }
      }

      if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
        logger.debug('Redirected to login/auth page');
        return false;
      }

      const bodyText = (await page.locator('body').textContent().catch(() => '')) || '';
      if (
        bodyText.includes('Good morning') ||
        bodyText.includes('Good afternoon') ||
        bodyText.includes('What do you want to know') ||
        bodyText.includes('How can I help')
      ) {
        logger.debug('Logged-in greeting text detected');
        return true;
      }

      logger.debug('No clear login state detected, assuming not logged in');
      return false;
    } catch (err) {
      logger.error('Error checking login state', { error: (err as Error).message });
      return false;
    }
  }

  async activateVoiceMode(page: Page, logger: Logger): Promise<boolean> {
    try {
      logger.info('Attempting to activate Grok voice mode...');

      await this.dismissCookieConsent(page, logger);
      await this.dismissModals(page, logger);

      // Log current URL and visible buttons for debugging
      logger.debug(`Grok page URL: ${page.url()}`);
      const micButtons = await page.locator('button[aria-label*="microphone" i], button[aria-label*="voice" i]').count();
      logger.debug(`Found ${micButtons} mic/voice buttons on Grok page`);

      const micLocator = page.locator('button[aria-label*="microphone" i], button[aria-label*="voice" i]').first();
      if ((await micLocator.count()) > 0) {
        const ariaLabel = await micLocator.getAttribute('aria-label').catch(() => 'unknown');
        logger.debug(`Mic button aria-label: ${ariaLabel}`);
        try {
          await micLocator.click({ force: true, timeout: 5000 });
          await page.waitForTimeout(1000);
          this.voiceModeActive = true;
          logger.info('Grok voice mode activated (force click)');
          return true;
        } catch (clickErr) {
          logger.warn('Force click failed, trying keyboard shortcut', { error: (clickErr as Error).message });
        }
      }

      try {
        await page.keyboard.press('Control+Shift+O');
        await page.waitForTimeout(500);
        this.voiceModeActive = true;
        logger.info('Grok voice mode activated (keyboard shortcut)');
        return true;
      } catch (kbErr) {
        logger.warn('Keyboard shortcut failed', { error: (kbErr as Error).message });
      }

      const fallback = page.locator('div[class*="input"] button, div[class*="chat"] button').first();
      if ((await fallback.count()) > 0) {
        await fallback.click({ force: true });
        this.voiceModeActive = true;
        logger.info('Grok voice mode activated (fallback)');
        return true;
      }

      logger.warn('Could not find microphone button on Grok page');
      return false;
    } catch (err) {
      logger.error('Failed to activate voice mode', { error: (err as Error).message });
      return false;
    }
  }

  async deactivateVoiceMode(page: Page, logger: Logger): Promise<boolean> {
    if (!this.voiceModeActive) {
      logger.debug('Voice mode already inactive');
      return true;
    }

    try {
      logger.info('Attempting to deactivate Grok voice mode...');

      try {
        await page.keyboard.press('Control+Shift+O');
        await page.waitForTimeout(500);
        this.voiceModeActive = false;
        logger.info('Grok voice mode deactivated (keyboard shortcut)');
        return true;
      } catch {
        // ignore
      }

      const stopBtn = await this.findButton(page, 'button[aria-label*="stop" i], button[aria-label*="cancel" i], button[aria-label*="keyboard" i]');
      if (stopBtn) {
        await stopBtn.click({ force: true });
        logger.debug('Clicked stop button');
      } else {
        const micBtn = await this.findButton(page, 'button[aria-label*="microphone" i], button[aria-label*="voice" i]');
        if (micBtn) {
          await micBtn.click({ force: true });
          logger.debug('Clicked mic button to toggle off');
        }
      }

      this.voiceModeActive = false;
      logger.info('Grok voice mode deactivated');
      return true;
    } catch (err) {
      logger.error('Failed to deactivate voice mode', { error: (err as Error).message });
      this.voiceModeActive = false;
      return false;
    }
  }

  isVoiceModeActive(): boolean {
    return this.voiceModeActive;
  }

  // ─── Private helpers ─────────────────────────────────────

  private async dismissCookieConsent(page: Page, logger: Logger): Promise<void> {
    try {
      const consentBtn = page.locator('button:has-text("Allow All"), button.ot-pc-refuse-all-handler, button.save-preference-btn-handler').first();
      if ((await consentBtn.count()) > 0 && (await consentBtn.isVisible().catch(() => false))) {
        await consentBtn.click();
        logger.debug('Dismissed cookie consent dialog');
        await page.waitForTimeout(500);
      }
    } catch {
      // ignore
    }
  }

  private async dismissModals(page: Page, logger: Logger): Promise<void> {
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      const closeSelectors = [
        'div[id="dialog-portal"] button svg[data-testid="CloseIcon"]',
        'div[id="dialog-portal"] button:has-text("Close")',
        'div[id="dialog-portal"] button:has-text("Got it")',
        'div[id="dialog-portal"] button:has-text("OK")',
        'div[id="dialog-portal"] button:has-text("Continue")',
        'div[role="dialog"] button:has-text("Close")',
        'div[role="dialog"] button:has-text("Got it")',
        'div[role="dialog"] button svg[data-testid="CloseIcon"]',
        'div[role="alertdialog"] button:has-text("OK")',
        '[data-state="open"] button[aria-label*="close" i]',
        'button svg[data-testid="CloseIcon"]',
      ];

      for (const sel of closeSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) {
            await btn.click({ force: true });
            logger.debug('Dismissed modal dialog');
            await page.waitForTimeout(300);
          }
        }
      }

      const portalOverlay = page.locator('div[id="dialog-portal"] > div[data-state="open"]').first();
      if ((await portalOverlay.count()) > 0) {
        const visible = await portalOverlay.isVisible().catch(() => false);
        if (visible) {
          const backdrop = page.locator('div[id="dialog-portal"] > div[data-state="open"] > div').first();
          if ((await backdrop.count()) > 0) {
            await backdrop.click({ force: true, position: { x: 1, y: 1 } });
            logger.debug('Clicked dialog backdrop to dismiss');
            await page.waitForTimeout(300);
          }
        }
      }
    } catch (err) {
      logger.debug('Error dismissing modals (non-fatal)', { error: (err as Error).message });
    }
  }

  private async findButton(page: Page, selector: string) {
    const locator = page.locator(selector).first();
    return (await locator.count()) > 0 ? locator : null;
  }
}
