/**
 * GrokController — Manages grok.com interactions and voice/speak mode activation
 */

import type { Page } from 'playwright';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';

export class GrokController {
  private voiceModeActive: boolean;
  private logger: Logger;

  constructor(logger: Logger = new SilentLogger()) {
    this.voiceModeActive = false;
    this.logger = logger;
  }

  async initialize(page: Page): Promise<boolean> {
    try {
      await page.context().grantPermissions(['microphone'], { origin: 'https://grok.com' });
      this.logger.debug('Microphone permission granted for grok.com');
    } catch (err) {
      this.logger.warn('Failed to grant microphone permissions', { error: (err as Error).message });
    }

    const isLoggedIn = await this.checkLoggedIn(page);
    this.logger.info(`Grok initialization complete. Logged in: ${isLoggedIn}`);
    return isLoggedIn;
  }

  async checkLoggedIn(page: Page): Promise<boolean> {
    try {
      const currentUrl = page.url();
      if (!currentUrl.includes('grok.com')) {
        this.logger.debug('Navigating to grok.com...');
        await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait for SPA to hydrate — grok.com is a heavy React app
      await page.waitForTimeout(10000);

      const url = page.url();

      // Check for login buttons
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
            this.logger.debug('Login button found on grok.com');
            return false;
          }
        }
      }

      // Check for chat inputs — grok.com uses a plain text input
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
          this.logger.debug('Chat input found on grok.com');
          return true;
        }
      }

      if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
        this.logger.debug('Redirected to login/auth page');
        return false;
      }

      const bodyText = (await page.locator('body').textContent().catch(() => '')) || '';
      if (bodyText.includes('Good morning') ||
        bodyText.includes('Good afternoon') ||
        bodyText.includes('What do you want to know') ||
        bodyText.includes('How can I help')
      ) {
        this.logger.debug('Logged-in greeting text detected');
        return true;
      }

      this.logger.debug('No clear login state detected, assuming not logged in');
      return false;
    } catch (err) {
      this.logger.error('Error checking login state', { error: (err as Error).message });
      return false;
    }
  }

  async activateVoiceMode(page: Page): Promise<boolean> {
    try {
      this.logger.info('Attempting to activate Grok voice mode...');

      // Dismiss any blocking dialogs/overlays first
      await this.dismissCookieConsent(page);
      await this.dismissModals(page);

      // Try primary selector with force click to bypass overlay interception
      const micLocator = page.locator('button[aria-label*="microphone" i], button[aria-label*="voice" i]').first();
      if ((await micLocator.count()) > 0) {
        try {
          await micLocator.click({ force: true, timeout: 5000 });
          this.voiceModeActive = true;
          this.logger.info('Grok voice mode activated (force click)');
          return true;
        } catch (clickErr) {
          this.logger.warn('Force click failed, trying keyboard shortcut', { error: (clickErr as Error).message });
        }
      }

      // Fallback: use keyboard shortcut Ctrl+Shift+O (as indicated by aria-label "Enter voice mode (Ctrl+⇧O)")
      try {
        await page.keyboard.press('Control+Shift+O');
        await page.waitForTimeout(500);
        this.voiceModeActive = true;
        this.logger.info('Grok voice mode activated (keyboard shortcut)');
        return true;
      } catch (kbErr) {
        this.logger.warn('Keyboard shortcut failed', { error: (kbErr as Error).message });
      }

      // Fallback: generic button near input
      const fallback = page.locator('div[class*="input"] button, div[class*="chat"] button').first();
      if ((await fallback.count()) > 0) {
        await fallback.click({ force: true });
        this.voiceModeActive = true;
        this.logger.info('Grok voice mode activated (fallback)');
        return true;
      }

      this.logger.warn('Could not find microphone button on Grok page');
      return false;
    } catch (err) {
      this.logger.error('Failed to activate voice mode', { error: (err as Error).message });
      return false;
    }
  }

  async deactivateVoiceMode(page: Page): Promise<boolean> {
    if (!this.voiceModeActive) {
      this.logger.debug('Voice mode already inactive');
      return true;
    }

    try {
      this.logger.info('Attempting to deactivate Grok voice mode...');

      // Try keyboard shortcut first (most reliable)
      try {
        await page.keyboard.press('Control+Shift+O');
        await page.waitForTimeout(500);
        this.voiceModeActive = false;
        this.logger.info('Grok voice mode deactivated (keyboard shortcut)');
        return true;
      } catch {
        // ignore
      }

      const stopBtn = await this.findButton(page,
        'button[aria-label*="stop" i], button[aria-label*="cancel" i], button[aria-label*="keyboard" i]'
      );

      if (stopBtn) {
        await stopBtn.click({ force: true });
        this.logger.debug('Clicked stop button');
      } else {
        const micBtn = await this.findButton(page,
          'button[aria-label*="microphone" i], button[aria-label*="voice" i]'
        );
        if (micBtn) {
          await micBtn.click({ force: true });
          this.logger.debug('Clicked mic button to toggle off');
        }
      }

      this.voiceModeActive = false;
      this.logger.info('Grok voice mode deactivated');
      return true;
    } catch (err) {
      this.logger.error('Failed to deactivate voice mode', { error: (err as Error).message });
      this.voiceModeActive = false;
      return false;
    }
  }

  isVoiceModeActive(): boolean {
    return this.voiceModeActive;
  }

  private async dismissCookieConsent(page: Page): Promise<void> {
    try {
      const consentBtn = page.locator('button:has-text("Allow All"), button.ot-pc-refuse-all-handler, button.save-preference-btn-handler').first();
      if ((await consentBtn.count()) > 0 && (await consentBtn.isVisible().catch(() => false))) {
        await consentBtn.click();
        this.logger.debug('Dismissed cookie consent dialog');
        await page.waitForTimeout(500);
      }
    } catch {
      // ignore
    }
  }

  private async dismissModals(page: Page): Promise<void> {
    try {
      // Press Escape to close any open modal dialogs
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Look for common close buttons in dialog-portal and other modal containers
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
            this.logger.debug('Dismissed modal dialog');
            await page.waitForTimeout(300);
          }
        }
      }

      // If dialog-portal overlay is still present, click its backdrop to dismiss
      const portalOverlay = page.locator('div[id="dialog-portal"] > div[data-state="open"]').first();
      if ((await portalOverlay.count()) > 0) {
        const visible = await portalOverlay.isVisible().catch(() => false);
        if (visible) {
          // Click on the backdrop (usually the first child which is the overlay background)
          const backdrop = page.locator('div[id="dialog-portal"] > div[data-state="open"] > div').first();
          if ((await backdrop.count()) > 0) {
            await backdrop.click({ force: true, position: { x: 1, y: 1 } });
            this.logger.debug('Clicked dialog backdrop to dismiss');
            await page.waitForTimeout(300);
          }
        }
      }
    } catch (err) {
      this.logger.debug('Error dismissing modals (non-fatal)', { error: (err as Error).message });
    }
  }

  private async findButton(page: Page, selector: string) {
    const locator = page.locator(selector).first();
    return (await locator.count()) > 0 ? locator : null;
  }
}
