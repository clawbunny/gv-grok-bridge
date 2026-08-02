/**
 * BrowserManager — launches and manages dual Chromium instances
 * for voice and AI providers with PulseAudio audio routing.
 *
 * Also owns page-level recovery and liveness signals:
 * - `recyclePage()` closes a hung page (which rejects all outstanding
 *   Playwright protocol calls against it) and opens a fresh one.
 * - WebSocket liveness tracking per page via CDP, so a provider page whose
 *   backend connection silently died is detected before it misses a call.
 * - An init script on the AI context hooks RTCPeerConnection/getUserMedia so
 *   the AI provider can verify voice sessions deterministically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { chromium } from 'playwright';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { BrowserConfig, BrowserPair, ProviderBrowserConfig } from '../../types';
import type { Logger } from '../../logger';
import { SilentLogger } from '../../logger';

export type BrowserLauncher = (
  profilePath: string,
  env: Record<string, string>,
) => Promise<BrowserContext>;

export type PageRole = 'voice' | 'ai';

/**
 * Hooks installed in the AI browsing context before any page script runs.
 * Records RTCPeerConnection instances and getUserMedia streams on
 * `window.__rtcHooks` so voice-session verification can inspect real
 * connection/track state instead of guessing from the DOM.
 */
export const RTC_HOOKS_INIT_SCRIPT = `(() => {
  window.__rtcHooks = { peers: [], streams: [] };
  try {
    const OrigPC = window.RTCPeerConnection;
    if (OrigPC) {
      const Hooked = function (...args) {
        const pc = new OrigPC(...args);
        window.__rtcHooks.peers.push(pc);
        return pc;
      };
      Hooked.prototype = OrigPC.prototype;
      window.RTCPeerConnection = Hooked;
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await origGum(constraints);
        window.__rtcHooks.streams.push(stream);
        return stream;
      };
    }
  } catch (e) { /* hooks are best-effort */ }
})();`;

export function createBrowserLauncher(headless: boolean, extraArgs?: string[]): BrowserLauncher {
  return (profilePath, env) =>
    chromium.launchPersistentContext(profilePath, {
      executablePath: '/usr/lib/chromium/chromium',
      headless: false,
      args: [
        '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
        '--use-fake-ui-for-media-stream',
        '--no-first-run',
        '--no-default-browser-check',
        ...(extraArgs || []),
      ],
      env,
    });
}

export class BrowserManager {
  private pair: BrowserPair | null = null;
  private providers: ProviderBrowserConfig | null = null;
  /** Live WebSocket request IDs per page role, tracked via CDP. */
  private openWebSockets: Record<PageRole, Set<string>> = { voice: new Set(), ai: new Set() };
  private cdpSessions: Partial<Record<PageRole, CDPSession>> = {};

  constructor(
    private launcher: BrowserLauncher,
    private logger: Logger = new SilentLogger(),
  ) {
    this.logger.debug('BrowserManager initialized');
  }

  async launch(config: BrowserConfig, providers: ProviderBrowserConfig, namespace: string): Promise<BrowserPair> {
    this.logger.info('Starting browser launch');
    let voiceCtx: BrowserContext | null = null;
    let aiCtx: BrowserContext | null = null;

    try {
      await this.killLingeringProcesses();
      this.prepareProfile(config);
      this.providers = providers;
      const display = config.headless ? (config.displayNum || ':99') : (process.env.DISPLAY || ':0');
      const envBase = { ...process.env, DISPLAY: display } as Record<string, string>;

      const appNameVoice = `Chromium-Voice-${namespace}`;
      const appNameAI = `Chromium-AI-${namespace}`;

      voiceCtx = await this.launchOne('voice', config.defaultProfilePath, {
        ...envBase,
        PULSE_SINK: `pipe_voice_to_ai_${namespace}`,
        PULSE_SOURCE: `src_ai_to_voice_${namespace}`,
        PULSE_PROP_application_name: appNameVoice,
      });
      aiCtx = await this.launchOne('ai', config.tempProfilePath, {
        ...envBase,
        PULSE_SINK: `pipe_ai_to_voice_${namespace}`,
        PULSE_SOURCE: `src_voice_to_ai_${namespace}`,
        PULSE_PROP_application_name: appNameAI,
      });

      await voiceCtx.grantPermissions(['microphone'], { origin: providers.voiceOrigin });
      await aiCtx.grantPermissions(['microphone'], { origin: providers.aiOrigin });
      await aiCtx.addInitScript(RTC_HOOKS_INIT_SCRIPT);
      this.logger.debug('Mic permissions granted, RTC hooks installed');

      const voicePage = await this.openPage(voiceCtx, providers.voiceUrl, 'Voice');
      const aiPage = await this.openPage(aiCtx, providers.aiUrl, 'AI');

      this.pair = { voice: voiceCtx, ai: aiCtx, voicePage, aiPage };
      await this.attachWebSocketTracking('voice');
      await this.attachWebSocketTracking('ai');
      this.logger.info('Browsers launched');
      return this.pair;
    } catch (err) {
      this.logger.error('Launch failed', { error: (err as Error).message });
      await this.safeClose(voiceCtx, aiCtx);
      this.pair = null;
      throw new Error(`BrowserManager launch failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (!this.pair) { this.logger.debug('No pair to close'); return; }
    await this.detachWebSocketTracking();
    await this.safeClose(this.pair.voice, this.pair.ai);
    this.pair = null;
    this.providers = null;
    this.logger.info('Browsers closed');
  }

  async healthCheck(): Promise<boolean> {
    if (!this.pair) { this.logger.warn('Health check: no pair'); return false; }
    try { this.pair.voice.pages(); this.pair.ai.pages(); return true; }
    catch (err) { this.logger.error('Health check failed', { error: (err as Error).message }); return false; }
  }

  /**
   * Close the page for the given role and open a fresh one at the provider
   * URL. Closing the page rejects all outstanding Playwright protocol calls
   * against it — this is what actually unblocks a hung renderer, where a
   * Promise.race timeout only abandons the promise.
   * Returns the new page; the BrowserPair is updated in place.
   */
  async recyclePage(role: PageRole): Promise<Page> {
    if (!this.pair || !this.providers) throw new Error('Browser pair not available');
    const ctx = role === 'voice' ? this.pair.voice : this.pair.ai;
    const oldPage = role === 'voice' ? this.pair.voicePage : this.pair.aiPage;
    const url = role === 'voice' ? this.providers.voiceUrl : this.providers.aiUrl;

    this.logger.info(`Recycling ${role} page`, { url });
    await this.detachWebSocketTracking(role);
    try { await oldPage.close(); } catch { /* already gone — fine */ }

    const page = await this.openPage(ctx, url, role === 'voice' ? 'Voice' : 'AI');
    if (role === 'voice') this.pair.voicePage = page;
    else this.pair.aiPage = page;
    await this.attachWebSocketTracking(role);
    this.logger.info(`${role} page recycled`);
    return page;
  }

  /** Number of currently open WebSockets on the given page (CDP-tracked). */
  getOpenWebSocketCount(role: PageRole): number {
    return this.openWebSockets[role].size;
  }

  async getCDPSession(instance: PageRole): Promise<CDPSession | null> {
    if (!this.pair) { this.logger.warn('No pair for CDP'); return null; }
    try {
      const ctx = instance === 'voice' ? this.pair.voice : this.pair.ai;
      return await ctx.newCDPSession(instance === 'voice' ? this.pair.voicePage : this.pair.aiPage);
    } catch (err) {
      this.logger.error('CDP session failed', { error: (err as Error).message });
      return null;
    }
  }

  getPair(): BrowserPair | null { return this.pair; }

  // ─── WebSocket liveness tracking ─────────────────────────

  private async attachWebSocketTracking(role: PageRole): Promise<void> {
    if (!this.pair) return;
    this.openWebSockets[role].clear();
    try {
      const page = role === 'voice' ? this.pair.voicePage : this.pair.aiPage;
      const cdp = await page.context().newCDPSession(page);
      this.cdpSessions[role] = cdp;
      cdp.on('Network.webSocketCreated', (event: { requestId: string }) => {
        this.openWebSockets[role].add(event.requestId);
      });
      cdp.on('Network.webSocketClosed', (event: { requestId: string }) => {
        this.openWebSockets[role].delete(event.requestId);
      });
      await cdp.send('Network.enable');
      this.logger.debug(`WebSocket tracking attached (${role})`);
    } catch (err) {
      this.logger.warn(`Failed to attach WebSocket tracking (${role})`, { error: (err as Error).message });
    }
  }

  private async detachWebSocketTracking(role?: PageRole): Promise<void> {
    const roles: PageRole[] = role ? [role] : ['voice', 'ai'];
    for (const r of roles) {
      const cdp = this.cdpSessions[r];
      if (cdp) {
        try { await cdp.detach(); } catch { /* ignore */ }
        delete this.cdpSessions[r];
      }
      this.openWebSockets[r].clear();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────

  private stripLockFiles(profilePath: string): void {
    const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of files) {
      const p = path.join(profilePath, file);
      try {
        fs.lstatSync(p);
        fs.rmSync(p, { force: true, recursive: true });
      } catch { /* ignore */ }
    }
  }

  private prepareProfile(config: BrowserConfig): void {
    this.stripLockFiles(config.defaultProfilePath);
    if (fs.existsSync(config.tempProfilePath)) fs.rmSync(config.tempProfilePath, { recursive: true, force: true });
    if (fs.existsSync(config.defaultProfilePath)) {
      fs.cpSync(config.defaultProfilePath, config.tempProfilePath, { recursive: true, force: true, dereference: true });
      this.stripLockFiles(config.tempProfilePath);
    } else {
      this.logger.warn('Default profile not found; creating fresh temp dir');
      fs.mkdirSync(config.tempProfilePath, { recursive: true });
    }
  }

  private async launchOne(label: string, profilePath: string, env: Record<string, string>): Promise<BrowserContext> {
    this.logger.info(`Launching ${label} browser`);
    const ctx = await this.launcher(profilePath, env);
    this.logger.debug(`${label} launched`);
    return ctx;
  }

  private async openPage(ctx: BrowserContext, url: string, label: string): Promise<Page> {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    this.logger.debug(`${label} navigated to ${url}`);
    return page;
  }

  private async killLingeringProcesses(): Promise<void> {
    try {
      const execAsync = promisify(exec);
      await execAsync("pkill -9 -f 'chromium' 2>/dev/null || true");
      this.logger.debug('Killed lingering Chromium processes');
    } catch {
      // ignore
    }
  }

  private async safeClose(a: BrowserContext | null, b?: BrowserContext | null): Promise<void> {
    for (const ctx of [a, b]) { if (ctx) try { await ctx.close(); } catch { /* ignore */ } }
  }
}
