/**
 * Grok Provider — implements AIProvider for grok.com
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import type { Logger } from '../../../logger';
import type { AIProvider } from '../../contracts';

const VOICE_ENTRY_SELECTOR = 'button[aria-label*="Enter voice mode" i]';
const DEBUG_DIR = process.env.GV_DEBUG_DIR || '/tmp/gv-bridge-debug';

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
      await this.resetRtcHooks(page);

      // Only the waveform "Enter voice mode" control. The composer also
      // has a dictation mic whose aria-label contains "microphone" —
      // clicking that starts speech-to-text, not a Grok voice session.
      const clicked = await this.clickVoiceEntry(page, logger);
      if (clicked) {
        if (await this.voiceEntryStillVisible(page)) {
          logger.warn('Enter voice mode still visible after click — sending shortcut once');
          await page.keyboard.press('Control+Shift+O').catch(() => undefined);
          await page.waitForTimeout(400);
        }
        // OneTrust often pops after getUserMedia and stalls "Connecting..."
        await this.dismissCookieConsent(page, logger);
        this.voiceModeActive = true;
        await this.dumpGrokState(page, logger, 'after-activate');
        return true;
      }

      try {
        await page.keyboard.press('Control+Shift+O');
        await page.waitForTimeout(500);
        this.voiceModeActive = true;
        logger.info('Grok voice mode activated (keyboard shortcut)');
        await this.dumpGrokState(page, logger, 'after-activate');
        return true;
      } catch (kbErr) {
        logger.warn('Keyboard shortcut failed', { error: (kbErr as Error).message });
      }

      logger.warn('Could not find Enter voice mode button on Grok page');
      await this.dumpGrokState(page, logger, 'activate-failed');
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
      const deadline = Date.now() + 2500;
      let iterations = 0;

      while (Date.now() < deadline && iterations < 8) {
        iterations++;
        if (await this.hasQuotaBlock(page, quotaPattern, logger)) return false;

        const rtcState = await this.readRtcState(page);
        // grok.com does not expose a hooked RTCPeerConnection (peers
        // stay []). A live mic track or the Connecting… control means
        // voice mode started — do not sit here for 8s delaying audio
        // routing while Grok finishes connecting.
        if (rtcState?.liveAudioTrack) {
          logger.info('Voice session verified via RTC hooks', rtcState);
          return true;
        }
        if (await this.isVoiceConnectingOrActive(page)) {
          logger.info('Voice session verified via Connecting/active UI');
          return true;
        }

        await page.waitForTimeout(200);
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
   * Only leave an existing thread. Clicking New Chat while already on
   * the empty composer remounts grok.com and delays voice by ~30s.
   */
  private async startFreshConversation(page: Page, logger: Logger): Promise<void> {
    const url = page.url();
    if (!/grok\.com\/chat\/[A-Za-z0-9_-]+/i.test(url)) {
      logger.info('Already on a fresh Grok composer — skipping New chat', { url });
      return;
    }

    const selectors = [
      'button[aria-label*="new chat" i]',
      'a[aria-label*="new chat" i]',
      'button:has-text("New Chat")',
      'a:has-text("New Chat")',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await this.visible(btn))) {
        try {
          await btn.click({ force: true, timeout: 3000, noWaitAfter: true });
          logger.info('Left previous Grok thread for a new conversation');
          await this.waitForVoiceEntry(page, 5000);
          return;
        } catch {
          // try the next selector
        }
      }
    }
  }

  private async clickVoiceEntry(page: Page, logger: Logger): Promise<boolean> {
    await this.waitForVoiceEntry(page, 4000);
    const btn = page.locator(VOICE_ENTRY_SELECTOR).first();
    if ((await btn.count()) === 0) return false;
    try {
      await btn.click({ force: true, timeout: 4000, noWaitAfter: true });
      logger.info('Grok voice mode activated (click)');
      return true;
    } catch (clickErr) {
      const msg = (clickErr as Error).message || '';
      if (/click action done|waiting for scheduled navigations/i.test(msg)) {
        logger.info('Grok voice mode activated (click; navigation wait ignored)');
        return true;
      }
      logger.warn('Enter voice mode click failed', { error: msg });
      return false;
    }
  }

  private async waitForVoiceEntry(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const btn = page.locator(VOICE_ENTRY_SELECTOR).first();
      if ((await btn.count()) > 0 && (await this.visible(btn))) return;
      await page.waitForTimeout(200);
    }
  }

  private async voiceEntryStillVisible(page: Page): Promise<boolean> {
    // Give the voice overlay a moment to replace the composer button.
    for (let i = 0; i < 8; i++) {
      const btn = page.locator(VOICE_ENTRY_SELECTOR).first();
      if ((await btn.count()) === 0 || !(await this.visible(btn))) return false;
      await page.waitForTimeout(200);
    }
    return true;
  }

  private async dumpGrokState(page: Page, logger: Logger, tag: string): Promise<void> {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const ts = Date.now();
      const png = path.join(DEBUG_DIR, `grok-${tag}-${ts}.png`);
      const json = path.join(DEBUG_DIR, `grok-${tag}-${ts}.json`);
      if (typeof page.screenshot === 'function') {
        await page.screenshot({ path: png }).catch(() => undefined);
      }
      const info = await page.evaluate(() => {
        const hooks = (window as unknown as {
          __rtcHooks?: { peers: RTCPeerConnection[]; streams: MediaStream[] };
        }).__rtcHooks;
        return {
          url: location.href,
          title: document.title,
          buttons: Array.from(document.querySelectorAll('button')).slice(0, 50).map((b) => ({
            aria: b.getAttribute('aria-label'),
            text: (b.textContent || '').trim().slice(0, 48),
          })),
          rtc: hooks
            ? {
                peers: hooks.peers.map((p) => p.connectionState),
                liveTracks: hooks.streams.filter(
                  (s) => s.active && s.getAudioTracks().some((t) => t.readyState === 'live'),
                ).length,
              }
            : null,
        };
      }).catch(() => null);
      if (info) fs.writeFileSync(json, JSON.stringify(info, null, 2));
      logger.info(`Grok UI dumped to ${png.replace(/\.png$/, '')}.{png,json}`, {
        url: info && (info as { url?: string }).url,
      });
    } catch (err) {
      logger.debug('Grok UI dump failed', { error: (err as Error).message });
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

  private async isVoiceConnectingOrActive(page: Page): Promise<boolean> {
    const connecting = page.locator('button[aria-label*="Connecting" i], [aria-label*="Connecting" i]').first();
    if ((await connecting.count()) > 0 && (await this.visible(connecting))) return true;
    return this.isVoiceUiActive(page);
  }

  private async isVoiceUiActive(page: Page): Promise<boolean> {
    const enter = page.locator('button[aria-label*="Enter voice mode" i]').first();
    if ((await enter.count()) > 0 && (await this.visible(enter))) return false;

    const activeSelectors = [
      'button[aria-label*="Connecting" i]',
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
    const selectors = [
      '#onetrust-accept-btn-handler',
      'button#onetrust-accept-btn-handler',
      'button:has-text("Allow All")',
      'button:has-text("Accept All")',
      'button.ot-pc-refuse-all-handler',
      'button.save-preference-btn-handler',
      'button[aria-label="Close preference center"]',
      '#onetrust-close-btn-container button',
    ];
    const clickIn = async (root: { locator: (sel: string) => { first: () => {
      count: () => Promise<number>;
      isVisible: (opts?: { timeout?: number }) => Promise<boolean>;
      click: (opts: object) => Promise<unknown>;
    } } }) => {
      for (const sel of selectors) {
        const btn = root.locator(sel).first();
        if ((await btn.count()) === 0) continue;
        try {
          await btn.click({ force: true, timeout: 1500, noWaitAfter: true });
          logger.info('Dismissed cookie / OneTrust dialog', { selector: sel });
          await page.waitForTimeout(300);
          return true;
        } catch {
          // try next
        }
      }
      return false;
    };

    try {
      if (await clickIn(page)) return;
      const frames = typeof page.frames === 'function' ? page.frames() : [];
      for (const frame of frames) {
        if (await clickIn(frame as unknown as Parameters<typeof clickIn>[0])) return;
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
