/**
 * BridgeOrchestrator — connects all modules and manages the GV-Grok call flow.
 *
 * Refactored: full dependency injection, simplified health checks,
 * extracted XvfbManager, single event wiring method.
 * Reduced from 527 lines to ~180.
 */

import type { BridgeConfig, BridgeStatus, CallInfo, AudioDevices } from '../types';
import type { AudioPipeline } from '../audio/pipeline';
import type { BrowserManager } from '../browser/manager';
import type { VoiceMonitor } from '../voice/monitor';
import type { GrokController } from '../grok/controller';
import type { XvfbManager } from './xvfb';
import type { Logger } from '../logger';

export { BridgeConfig, BridgeStatus };

export class BridgeOrchestrator {
  private status: BridgeStatus;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private devices: AudioDevices | null = null;

  constructor(
    private config: BridgeConfig,
    private audioPipeline: AudioPipeline,
    private browserManager: BrowserManager,
    private voiceMonitor: VoiceMonitor,
    private grokController: GrokController,
    private xvfbManager: XvfbManager,
    private logger: Logger,
  ) {
    this.status = this.createDefaultStatus();
  }

  // ─── Public API ──────────────────────────────────────────

  async start(): Promise<void> {
    this.logger.info('Starting GV-Grok Bridge', this.config as unknown as Record<string, unknown>);

    try {
      await this.setupAudio();

      if (this.config.headless) {
        await this.xvfbManager.start(this.config.displayNum || ':99');
      }

      await this.launchBrowsers();
      await this.checkLogins();
      this.setupEventWiring();
      this.startHealthChecks();

      this.status.running = true;
      this.logger.info('Bridge started successfully');
    } catch (err) {
      this.logger.error('Bridge startup failed', { error: (err as Error).message });
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping bridge...');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    try { this.voiceMonitor.stopMonitoring(); } catch { /* ignore */ }
    try { await this.browserManager.close(); } catch { /* ignore */ }

    if (this.devices) {
      try { await this.audioPipeline.teardown(this.devices); } catch { /* ignore */ }
      this.devices = null;
    }

    this.xvfbManager.stop();
    this.status = this.createDefaultStatus();
    this.logger.info('Bridge stopped');
  }

  getStatus(): BridgeStatus {
    return { ...this.status };
  }

  // ─── Startup helpers ─────────────────────────────────────

  private async setupAudio(): Promise<void> {
    this.devices = await this.audioPipeline.setup();
    this.status.audioReady = true;
    this.logger.info('Audio pipeline ready', { devices: this.devices as unknown as Record<string, unknown> });
  }

  private async launchBrowsers(): Promise<void> {
    await this.browserManager.launch(this.config);
    this.status.gvBrowserReady = true;
    this.status.grokBrowserReady = true;
    this.logger.info('Browsers launched');
  }

  private async checkLogins(): Promise<void> {
    const pair = this.browserManager.getPair();
    if (!pair) throw new Error('Browser pair not available');

    const voiceConfig = {
      authorizedNumbers: this.config.authorizedNumbers,
      authorizedNames: this.config.authorizedNames,
      autoAccept: this.config.autoAccept,
      pollInterval: this.config.pollInterval,
    };

    await this.voiceMonitor.startMonitoring(pair.gvPage, voiceConfig);

    const grokLoggedIn = await this.grokController.initialize(pair.grokPage);
    const gvUrl = pair.gvPage.url();
    const gvLoggedIn = gvUrl.includes('voice.google.com') && !gvUrl.includes('accounts.google.com');

    this.status.gvLoggedIn = gvLoggedIn;
    this.status.grokLoggedIn = grokLoggedIn;
    this.logger.info('Login check complete', { gvLoggedIn, grokLoggedIn });

    if (!gvLoggedIn) this.logger.warn('Google Voice not logged in');
    if (!grokLoggedIn) this.logger.warn('Grok not logged in');
  }

  // ─── Event wiring ────────────────────────────────────────

  private setupEventWiring(): void {
    this.voiceMonitor.on('incomingCall', (call: CallInfo) =>
      this.onIncomingCall(call).catch((err) =>
        this.logger.error('Error in onIncomingCall', { error: (err as Error).message }),
      ),
    );
    this.voiceMonitor.on('callAccepted', (call: CallInfo) =>
      this.onCallAccepted(call).catch((err) =>
        this.logger.error('Error in onCallAccepted', { error: (err as Error).message }),
      ),
    );
    this.voiceMonitor.on('callEnded', () =>
      this.onCallEnded().catch((err) =>
        this.logger.error('Error in onCallEnded', { error: (err as Error).message }),
      ),
    );
    this.voiceMonitor.on('error', (err: Error) =>
      this.logger.error('Voice monitor error', { error: err.message }),
    );
    this.logger.debug('Event wiring complete');
  }

  // ─── Call flow handlers ──────────────────────────────────

  private async onIncomingCall(call: CallInfo): Promise<void> {
    this.logger.info(`Incoming call from ${call.callerName} (${call.phoneNumber})`);
  }

  private async onCallAccepted(call: CallInfo): Promise<void> {
    this.logger.info('Call accepted, activating Grok voice mode...');
    this.status.inCall = true;
    this.status.currentCall = call;

    try {
      const pair = this.browserManager.getPair();
      if (!pair) throw new Error('Browser pair not available');
      const activated = await this.grokController.activateVoiceMode(pair.grokPage);
      this.status.voiceModeActive = activated;

      // Give Chromium a moment to create audio streams, then fix routing
      setTimeout(() => {
        this.audioPipeline.fixStreamRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio routing fix failed', { error: (err as Error).message }),
        );
      }, 2000).unref();

      // Fix again after a longer delay in case stream-restore moves things
      setTimeout(() => {
        this.audioPipeline.fixStreamRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio routing fix failed', { error: (err as Error).message }),
        );
      }, 8000).unref();
    } catch (err) {
      this.logger.error('Failed to activate Grok voice mode', { error: (err as Error).message });
    }
  }

  private async onCallEnded(): Promise<void> {
    this.logger.info('Call ended, deactivating Grok voice mode...');
    this.status.inCall = false;
    this.status.currentCall = undefined;

    try {
      const pair = this.browserManager.getPair();
      if (!pair) throw new Error('Browser pair not available');
      await this.grokController.deactivateVoiceMode(pair.grokPage);
      this.status.voiceModeActive = false;
    } catch (err) {
      this.logger.error('Error deactivating Grok voice mode', { error: (err as Error).message });
      this.status.voiceModeActive = false;
    }
  }

  // ─── Health checks ───────────────────────────────────────

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        const healthy = await this.browserManager.healthCheck();
        if (!healthy) {
          this.logger.error('Browser health check failed');
          this.status.gvBrowserReady = false;
          this.status.grokBrowserReady = false;
        }

        // Fix audio routing during active calls
        if (this.status.inCall) {
          await this.audioPipeline.fixStreamRouting(
            this.config.defaultProfilePath,
            this.config.tempProfilePath,
          );
        }
      } catch (err) {
        this.logger.error('Health check error', { error: (err as Error).message });
      }
    }, 10000);
    this.logger.debug('Health checks started (interval: 10000ms)');
  }

  // ─── Status helpers ──────────────────────────────────────

  private createDefaultStatus(): BridgeStatus {
    return {
      running: false,
      audioReady: false,
      gvBrowserReady: false,
      grokBrowserReady: false,
      gvLoggedIn: false,
      grokLoggedIn: false,
      inCall: false,
      voiceModeActive: false,
    };
  }
}
