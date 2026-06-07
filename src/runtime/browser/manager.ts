/**
 * BrowserManager — launches and manages dual Chromium instances
 * for voice and AI providers with PulseAudio audio routing.
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
      this.logger.debug('Mic permissions granted');

      const voicePage = await this.openPage(voiceCtx, providers.voiceUrl, 'Voice');
      const aiPage = await this.openPage(aiCtx, providers.aiUrl, 'AI');

      this.pair = { voice: voiceCtx, ai: aiCtx, voicePage, aiPage };
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
    await this.safeClose(this.pair.voice, this.pair.ai);
    this.pair = null;
    this.logger.info('Browsers closed');
  }

  async healthCheck(): Promise<boolean> {
    if (!this.pair) { this.logger.warn('Health check: no pair'); return false; }
    try { this.pair.voice.pages(); this.pair.ai.pages(); return true; }
    catch (err) { this.logger.error('Health check failed', { error: (err as Error).message }); return false; }
  }

  async getCDPSession(instance: 'voice' | 'ai'): Promise<CDPSession | null> {
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
