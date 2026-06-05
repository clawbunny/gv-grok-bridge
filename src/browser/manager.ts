/**
 * BrowserManager — launches and manages dual Chromium instances
 * for Google Voice and Grok AI with PulseAudio audio routing.
 *
 * Refactored: injected launcher + logger, small focused methods,
 * single safeClose helper instead of 4 nested try/catch blocks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { chromium } from 'playwright';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { BrowserConfig, BrowserPair } from '../types';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';

/** Injected launcher type — production uses Playwright, tests inject mocks */
export type BrowserLauncher = (
  profilePath: string,
  env: Record<string, string>,
) => Promise<BrowserContext>;

/** Production launcher factory */
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

  /** Launch both GV and Grok browser instances. */
  async launch(config: BrowserConfig): Promise<BrowserPair> {
    this.logger.info('Starting browser launch');
    let gvCtx: BrowserContext | null = null;
    let grokCtx: BrowserContext | null = null;

    try {
      await this.killLingeringProcesses();
      this.prepareProfile(config);
      const display = config.headless ? (config.displayNum || ':99') : (process.env.DISPLAY || ':0');
      const envBase = { ...process.env, DISPLAY: display } as Record<string, string>;

      gvCtx = await this.launchOne('gv', config.defaultProfilePath, {
        ...envBase,
        PULSE_SINK: 'pipe_gv_to_grok',
        PULSE_SOURCE: 'src_grok_to_gv',
        PULSE_PROP_application_name: 'Chromium-GV',
      });
      grokCtx = await this.launchOne('grok', config.tempProfilePath, {
        ...envBase,
        PULSE_SINK: 'pipe_grok_to_gv',
        PULSE_SOURCE: 'src_gv_to_grok',
        PULSE_PROP_application_name: 'Chromium-Grok',
      });

      await gvCtx.grantPermissions(['microphone'], { origin: 'https://voice.google.com' });
      await grokCtx.grantPermissions(['microphone'], { origin: 'https://grok.com' });
      this.logger.debug('Mic permissions granted');

      const gvPage = await this.openPage(gvCtx, 'https://voice.google.com', 'GV');
      const grokPage = await this.openPage(grokCtx, 'https://grok.com', 'Grok');

      this.pair = { gv: gvCtx, grok: grokCtx, gvPage, grokPage };
      this.logger.info('Browsers launched');
      return this.pair;
    } catch (err) {
      this.logger.error('Launch failed', { error: (err as Error).message });
      await this.safeClose(gvCtx, grokCtx);
      this.pair = null;
      throw new Error(`BrowserManager launch failed: ${(err as Error).message}`);
    }
  }

  /** Close both browser contexts and clear the pair reference. */
  async close(): Promise<void> {
    if (!this.pair) { this.logger.debug('No pair to close'); return; }
    await this.safeClose(this.pair.gv, this.pair.grok);
    this.pair = null;
    this.logger.info('Browsers closed');
  }

  /** Return true when both contexts are still alive. */
  async healthCheck(): Promise<boolean> {
    if (!this.pair) { this.logger.warn('Health check: no pair'); return false; }
    try { this.pair.gv.pages(); this.pair.grok.pages(); return true; }
    catch (err) { this.logger.error('Health check failed', { error: (err as Error).message }); return false; }
  }

  /** Get a CDP session for the specified browser instance. */
  async getCDPSession(instance: 'gv' | 'grok'): Promise<CDPSession | null> {
    if (!this.pair) { this.logger.warn('No pair for CDP'); return null; }
    try {
      const ctx = instance === 'gv' ? this.pair.gv : this.pair.grok;
      return await ctx.newCDPSession(instance === 'gv' ? this.pair.gvPage : this.pair.grokPage);
    } catch (err) {
      this.logger.error('CDP session failed', { error: (err as Error).message });
      return null;
    }
  }

  /** Get the current browser pair, or null if not launched. */
  getPair(): BrowserPair | null { return this.pair; }

  // ─── Helpers ─────────────────────────────────────────────

  private stripLockFiles(profilePath: string): void {
    const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of files) {
      const p = path.join(profilePath, file);
      try {
        fs.lstatSync(p); // detects broken symlinks too (existsSync follows them)
        fs.rmSync(p, { force: true, recursive: true });
      } catch { /* ignore — doesn't exist */ }
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
      // ignore — either no processes existed or pkill failed
    }
  }

  private async safeClose(a: BrowserContext | null, b?: BrowserContext | null): Promise<void> {
    for (const ctx of [a, b]) { if (ctx) try { await ctx.close(); } catch { /* ignore */ } }
  }
}
