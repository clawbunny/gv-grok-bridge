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

      // Condition-based wait: poll until either a logged-in signal (chat
      // composer) or a logged-out signal (login button / auth redirect)
      // appears. No fixed sleeps — the first decisive signal wins.
      const composerSelector = [
        'textarea',
        'div[contenteditable="true"]',
        '[data-testid="message-input"]',
        'div[role="textbox"]',
      ].join(', ');
      const loginSelector = [
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'a:has-text("Log in")',
        'a:has-text("Sign in")',
        '[data-testid="login-button"]',
        'button[aria-label*="login" i]',
      ].join(', ');

      const deadline = Date.now() + 30000;
      let iterations = 0;
      while (Date.now() < deadline && iterations < 45) {
        iterations++;
        const url = page.url();
        if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
          logger.debug('Redirected to login/auth page');
          return false;
        }

        const loginBtn = page.locator(loginSelector).first();
        if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible().catch(() => false))) {
          logger.debug('Login button found on grok.com');
          return false;
        }

        const composer = page.locator(composerSelector).first();
        if ((await composer.count()) > 0 && (await composer.isVisible().catch(() => false))) {
          logger.debug('Chat composer found on grok.com');
          return true;
        }

        await page.waitForTimeout(1000);
      }

      logger.warn('No decisive login signal within 30s, assuming not logged in');
      return false;
    } catch (err) {
      logger.error('Error checking login state', { error: (err as Error).message });
      return false;
    }
  }

  async activateVoiceMode(page: Page, logger: Logger): Promise<boolean> {
    try {
      logger.info('Attempting to activate Grok voice mode...');

      await this.startFreshConversation(page, logger);
      await this.dismissCookieConsent(page, logger);
      await this.dismissModals(page, logger);
      // Drop leftover peers/streams so verifyVoiceSession cannot pass
      // on a previous call's WebRTC objects.
      await this.resetRtcHooks(page);

      const micLocator = page.locator(
        'button[aria-label*="Enter voice mode" i], button[aria-label*="microphone" i], button[aria-label*="voice" i]',
      ).first();
      if ((await micLocator.count()) > 0) {
        try {
          // noWaitAfter: grok.com treats voice-mode as a client-side
          // navigation. Playwright's default click waits for that
          // navigation, times out after the click already landed, and
          // the old keyboard fallback then *toggled voice back off*.
          await micLocator.click({ force: true, timeout: 4000, noWaitAfter: true });
          this.voiceModeActive = true;
          logger.info('Grok voice mode activated (click)');
          return true;
        } catch (clickErr) {
          const msg = (clickErr as Error).message || '';
          if (/click action done|waiting for scheduled navigations/i.test(msg)) {
            this.voiceModeActive = true;
            logger.info('Grok voice mode activated (click; navigation wait ignored)');
            return true;
          }
          logger.warn('Click failed, trying keyboard shortcut', { error: msg });
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
        await stopBtn.click({ force: true, noWaitAfter: true });
        logger.debug('Clicked stop button');
      } else {
        const micBtn = await this.findButton(page, 'button[aria-label*="microphone" i], button[aria-label*="voice" i]');
        if (micBtn) {
          await micBtn.click({ force: true, noWaitAfter: true });
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

  async verifyVoiceSession(page: Page, logger: Logger): Promise<boolean> {
    try {
      const quotaPattern = /upgrade|subscribe|super ?grok|credit|limit reached|try again later|unavailable/i;
      const deadline = Date.now() + 8000;
      let iterations = 0;

      while (Date.now() < deadline && iterations < 20) {
        iterations++;
        if (await this.hasQuotaBlock(page, quotaPattern, logger)) return false;

        const rtcState = await this.readRtcState(page);
        // A leftover RTCPeerConnection from a previous call is not proof
        // (hooks are reset just before the click). Prefer a live mic
        // track AND a connected peer — getUserMedia comes up first,
        // Grok's voice peer a second or two later. Returning on the
        // mic alone used to mark BRIDGED before Grok could speak.
        if (rtcState?.liveAudioTrack && rtcState?.connectedPeer) {
          logger.info('Voice session verified via RTC hooks', rtcState);
          return true;
        }

        const uiActive = await this.isVoiceUiActive(page);
        if (uiActive && rtcState?.connectedPeer) {
          logger.info('Voice session verified via UI + connected peer', rtcState);
          return true;
        }

        await page.waitForTimeout(400);
      }

      if (await this.hasQuotaBlock(page, quotaPattern, logger)) return false;

      const rtcState = await this.readRtcState(page);
      if (rtcState?.liveAudioTrack) {
        logger.info('Voice session verified via RTC hooks', rtcState);
        return true;
      }

      if (await this.isVoiceUiActive(page)) {
        logger.debug('Voice UI looks active');
        return true;
      }

      const bodyText = (await page.locator('body').textContent().catch(() => '')) || '';
      if (/(voice|audio).{0,40}(upgrade|subscribe|limit|unavailable)/i.test(bodyText)) {
        logger.warn('Grok voice session appears unavailable (page text)');
        return false;
      }

      logger.warn('No voice-session indicators found on Grok page after activation', {
        rtcState: rtcState ?? undefined,
      });
      return false;
    } catch (err) {
      logger.error('Failed to verify voice session', { error: (err as Error).message });
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────

  /**
   * Open a new Grok conversation so voice starts on a clean thread
   * rather than a days-old chat that still has a half-dead voice UI.
   */
  private async startFreshConversation(page: Page, logger: Logger): Promise<void> {
    const selectors = [
      'button[aria-label*="new chat" i]',
      'a[aria-label*="new chat" i]',
      'button[aria-label*="new conversation" i]',
      'a[aria-label*="new conversation" i]',
      'button:has-text("New chat")',
      'a:has-text("New chat")',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await this.visible(btn))) {
        try {
          await btn.click({ force: true, timeout: 3000, noWaitAfter: true });
          logger.info('Started a fresh Grok conversation');
          await page.waitForTimeout(800);
          return;
        } catch {
          // try the next selector
        }
      }
    }

    const url = page.url();
    if (/grok\.com\/chat\//i.test(url) || !/grok\.com/i.test(url)) {
      try {
        await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        logger.info('Navigated to grok.com for a fresh session');
      } catch (err) {
        logger.warn('Could not navigate to grok.com', { error: (err as Error).message });
      }
    }
  }

  private async resetRtcHooks(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const hooks = (window as unknown as { __rtcHooks?: { peers: unknown[]; streams: unknown[] } }).__rtcHooks;
        if (hooks) {
          hooks.peers = [];
          hooks.streams = [];
        }
      });
    } catch {
      // hooks unavailable on this page — verify will fall back to the DOM
    }
  }

  private async readRtcState(page: Page): Promise<{ liveAudioTrack: boolean; connectedPeer: boolean } | null> {
    try {
      return await page.evaluate(() => {
        const hooks = (window as unknown as {
          __rtcHooks?: { streams: MediaStream[]; peers: RTCPeerConnection[] };
        }).__rtcHooks;
        if (!hooks) return null;
        const liveAudioTrack = hooks.streams.some(
          (s) => s.active && s.getAudioTracks().some((t) => t.enabled && t.readyState === 'live'),
        );
        const connectedPeer = hooks.peers.some((pc) => pc.connectionState === 'connected');
        return { liveAudioTrack, connectedPeer };
      });
    } catch {
      return null;
    }
  }

  private async isVoiceUiActive(page: Page): Promise<boolean> {
    const enter = page.locator('button[aria-label*="Enter voice mode" i]').first();
    if ((await enter.count()) > 0 && (await this.visible(enter))) return false;

    const activeSelectors = [
      'button[aria-label*="stop" i]',
      'button[aria-label*="end" i]',
      'button[aria-label*="mute" i]',
      'button[aria-label*="exit voice" i]',
      '[class*="voice"][class*="active"]',
      '[class*="listening"]',
      '[class*="orb"]',
    ];
    for (const sel of activeSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await this.visible(loc))) return true;
    }
    return false;
  }

  private async hasQuotaBlock(page: Page, quotaPattern: RegExp, logger: Logger): Promise<boolean> {
    const dialog = page.locator('div[role="dialog"], div[role="alertdialog"], div[id="dialog-portal"] [data-state="open"]').first();
    if ((await dialog.count()) > 0) {
      const text = (await dialog.textContent().catch(() => '')) || '';
      if (quotaPattern.test(text)) {
        logger.warn('Grok voice session blocked by quota/upsell dialog', { detail: text.slice(0, 120) });
        return true;
      }
    }
    return false;
  }

  private async visible(locator: { isVisible: (opts?: { timeout?: number }) => Promise<boolean> }): Promise<boolean> {
    return locator.isVisible({ timeout: 500 }).catch(() => false);
  }

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
