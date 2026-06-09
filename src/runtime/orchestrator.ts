/**
 * BridgeOrchestrator — connects all modules and manages the call flow.
 */

import type { BridgeConfig, BridgeStatus, CallInfo, AudioDevices } from '../types';
import type { AudioPipeline } from './audio/pipeline';
import type { BrowserManager } from './browser/manager';
import type { VoiceMonitor } from './monitor';
import type { AIController } from './ai-controller';
import type { XvfbManager } from './xvfb';
import type { VoiceProvider, AIProvider } from '../providers/contracts';
import type { Logger } from '../logger';
import type { AlertManager } from './alert/manager';
import type { StatusFileWriter } from './status/writer';

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
    private aiController: AIController,
    private voiceProvider: VoiceProvider,
    private aiProvider: AIProvider,
    private xvfbManager: XvfbManager,
    private logger: Logger,
    private alertManager?: AlertManager,
    private statusWriter?: StatusFileWriter,
  ) {
    this.status = this.createDefaultStatus();
  }

  // ─── Public API ──────────────────────────────────────────

  async start(): Promise<void> {
    this.logger.info('Starting Bridge', this.config as unknown as Record<string, unknown>);

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
    await this.browserManager.launch(this.config, {
      voiceUrl: this.voiceProvider.url,
      aiUrl: this.aiProvider.url,
      voiceOrigin: this.voiceProvider.origin,
      aiOrigin: this.aiProvider.origin,
    }, this.config.namespace);
    this.status.voiceBrowserReady = true;
    this.status.aiBrowserReady = true;
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

    await this.voiceProvider.initialize(pair.voicePage, this.logger);
    await this.voiceMonitor.startMonitoring(pair.voicePage, this.voiceProvider, voiceConfig);

    const aiLoggedIn = await this.aiController.initialize(pair.aiPage, this.aiProvider);
    const voiceLoggedIn = await this.voiceProvider.checkLoggedIn(pair.voicePage, this.logger);

    this.status.voiceLoggedIn = voiceLoggedIn;
    this.status.aiLoggedIn = aiLoggedIn;
    this.logger.info('Login check complete', { voiceLoggedIn, aiLoggedIn });

    if (!voiceLoggedIn) this.logger.warn('Voice provider not logged in');
    if (!aiLoggedIn) this.logger.warn('AI provider not logged in');
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
    try {
      const d = this.audioPipeline.deviceNames;
      await this.audioPipeline.setDefaultSource(d.aiSource);
      this.logger.info(`Set default source to ${d.aiSource} for voice browser`);
      await this.audioPipeline.setDefaultSink(d.voiceSink);
      this.logger.info(`Set default sink to ${d.voiceSink} for voice browser`);
    } catch (err) {
      this.logger.warn('Failed to set default audio for incoming call', { error: (err as Error).message });
    }
  }

  private async onCallAccepted(call: CallInfo): Promise<void> {
    this.logger.info('Call accepted, activating AI voice mode...');
    this.status.inCall = true;
    this.status.currentCall = call;

    try {
      const pair = this.browserManager.getPair();
      if (!pair) throw new Error('Browser pair not available');

      // Set default audio for AI browser before activating voice mode
      try {
        const d = this.audioPipeline.deviceNames;
        await this.audioPipeline.setDefaultSource(d.voiceSource);
        this.logger.info(`Set default source to ${d.voiceSource} for AI browser`);
        await this.audioPipeline.setDefaultSink(d.aiSink);
        this.logger.info(`Set default sink to ${d.aiSink} for AI browser`);
      } catch (err) {
        this.logger.warn('Failed to set default audio for AI browser', { error: (err as Error).message });
      }

      const activated = await this.aiController.activateVoiceMode(pair.aiPage);
      this.status.voiceModeActive = activated;

      setTimeout(() => {
        this.audioPipeline.fixStreamRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio routing fix failed', { error: (err as Error).message }),
        );
        this.audioPipeline.fixSinkRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio sink routing fix failed', { error: (err as Error).message }),
        );
      }, 2000).unref();

      setTimeout(() => {
        this.audioPipeline.fixStreamRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio routing fix failed', { error: (err as Error).message }),
        );
        this.audioPipeline.fixSinkRouting(
          this.config.defaultProfilePath,
          this.config.tempProfilePath,
        ).catch((err) =>
          this.logger.error('Audio sink routing fix failed', { error: (err as Error).message }),
        );
      }, 8000).unref();
    } catch (err) {
      this.logger.error('Failed to activate AI voice mode', { error: (err as Error).message });
    }
  }

  private async onCallEnded(): Promise<void> {
    this.logger.info('Call ended, deactivating AI voice mode...');
    this.status.inCall = false;
    this.status.currentCall = undefined;

    try {
      const d = this.audioPipeline.deviceNames;
      await this.audioPipeline.setDefaultSource(`${d.voiceSink}.monitor`);
      this.logger.info(`Restored default source to ${d.voiceSink}.monitor`);
      await this.audioPipeline.setDefaultSink(d.voiceSink);
      this.logger.info(`Restored default sink to ${d.voiceSink}`);
    } catch (err) {
      this.logger.warn('Failed to restore default audio', { error: (err as Error).message });
    }

    try {
      const pair = this.browserManager.getPair();
      if (!pair) throw new Error('Browser pair not available');
      await this.aiController.deactivateVoiceMode(pair.aiPage);
      this.status.voiceModeActive = false;
    } catch (err) {
      this.logger.error('Error deactivating AI voice mode', { error: (err as Error).message });
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
          this.status.voiceBrowserReady = false;
          this.status.aiBrowserReady = false;
        }

        if (this.status.inCall) {
          await this.audioPipeline.fixStreamRouting(
            this.config.defaultProfilePath,
            this.config.tempProfilePath,
          );
          await this.audioPipeline.fixSinkRouting(
            this.config.defaultProfilePath,
            this.config.tempProfilePath,
          );
        }

        const criticalIssues = this.alertManager?.detectCriticalIssues(this.status) ?? [];
        this.statusWriter?.write(this.status, criticalIssues);
        this.alertManager?.checkAndAlert(this.status, this.config.alertEmail);
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
      voiceBrowserReady: false,
      aiBrowserReady: false,
      voiceLoggedIn: false,
      aiLoggedIn: false,
      inCall: false,
      voiceModeActive: false,
    };
  }
}
