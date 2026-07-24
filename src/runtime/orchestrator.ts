/**
 * BridgeOrchestrator — connects all modules and manages the call flow.
 */

import type { BridgeConfig, BridgeStatus, CallInfo, AudioDevices, Page } from '../types';
import type { AudioPipeline } from './audio/pipeline';
import type { BrowserManager } from './browser/manager';
import type { VoiceMonitor } from './monitor';
import type { AIController } from './ai-controller';
import type { XvfbManager } from './xvfb';
import type { StatusFileWriter } from './status/writer';
import type { VoiceProvider, AIProvider } from '../providers/contracts';
import type { Logger } from '../logger';

export { BridgeConfig, BridgeStatus };

/** Number of consecutive failed DOM probes before a page is declared unresponsive. */
const PROBE_FAILURE_THRESHOLD = 3;
/** Timeout for a single DOM probe (ms). */
const PROBE_TIMEOUT_MS = 5000;

/** Map bridge status to human-readable critical issues for the status file / CLI. */
export function computeCriticalIssues(status: BridgeStatus): string[] {
  const issues: string[] = [];
  if (status.running && !status.audioReady) issues.push('audio_not_ready');
  if (status.running && !status.voiceBrowserReady) issues.push('voice_browser_not_ready');
  if (status.running && !status.aiBrowserReady) issues.push('ai_browser_not_ready');
  if (status.running && !status.voiceLoggedIn) issues.push('voice_not_logged_in');
  if (status.running && !status.aiLoggedIn) issues.push('ai_not_logged_in');
  if (!status.voicePageResponsive) issues.push('voice_page_unresponsive');
  if (!status.aiPageResponsive) issues.push('ai_page_unresponsive');
  if (status.aiVoiceUnavailable) {
    issues.push(`ai_voice_unavailable: ${status.aiVoiceStatusDetail ?? 'AI voice session could not be established'}`);
  }
  return issues;
}

export class BridgeOrchestrator {
  private status: BridgeStatus;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private devices: AudioDevices | null = null;
  private consecutiveVoiceProbeFailures = 0;
  private consecutiveAiProbeFailures = 0;
  private pendingRestart: string | null = null;
  private lastReloadAt = 0;

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
      this.lastReloadAt = Date.now();
      this.writeStatusFile();
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

    await this.voiceMonitor.startMonitoring(pair.voicePage, this.voiceProvider, voiceConfig);

    const aiLoggedIn = await this.aiController.initialize(pair.aiPage, this.aiProvider);
    const voiceLoggedIn = await this.voiceProvider.checkLoggedIn(pair.voicePage, this.logger);

    this.status.voiceLoggedIn = voiceLoggedIn;
    this.status.aiLoggedIn = aiLoggedIn;
    this.logger.info('Login check complete', { voiceLoggedIn, aiLoggedIn });

    if (!voiceLoggedIn) {
      throw new Error(
        'Voice provider (Google Voice) is not logged in. ' +
        'Log in with: cd ~/voicebridge-setup && ./open-browser.sh, ' +
        'then stop and restart this service.'
      );
    }
    if (!aiLoggedIn) {
      throw new Error(
        'AI provider is not logged in. ' +
        'Log in with: cd ~/voicebridge-setup && ./open-browser.sh, ' +
        'then stop and restart this service.'
      );
    }
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

      // Verify a voice session really started — activation clicks can
      // silently no-op (e.g. account out of voice credits)
      if (activated && this.aiProvider.verifyVoiceSession) {
        const verified = await this.aiProvider.verifyVoiceSession(pair.aiPage, this.logger);
        if (verified) {
          if (this.status.aiVoiceUnavailable) {
            this.logger.info('AI voice session verified — clearing aiVoiceUnavailable');
          }
          this.status.aiVoiceUnavailable = false;
          this.status.aiVoiceStatusDetail = undefined;
        } else {
          this.status.aiVoiceUnavailable = true;
          this.status.aiVoiceStatusDetail =
            'AI voice session did not start after activation click (account may be out of voice credits)';
          this.logger.error('AI voice session verification failed', { detail: this.status.aiVoiceStatusDetail });
        }
        this.writeStatusFile();
      }

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

    // A restart deferred while the call was active can proceed now
    if (this.pendingRestart) {
      await this.maybeRestart();
    }
  }

  // ─── Health checks ───────────────────────────────────────

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.runHealthTick();
      } catch (err) {
        this.logger.error('Health check error', { error: (err as Error).message });
      }
    }, 10000);
    this.logger.debug('Health checks started (interval: 10000ms)');
  }

  private async runHealthTick(): Promise<void> {
    const healthy = await this.browserManager.healthCheck();
    if (!healthy) {
      this.logger.error('Browser health check failed');
      this.status.voiceBrowserReady = false;
      this.status.aiBrowserReady = false;
    }

    // DOM probes — detect pages that are hung or otherwise unresponsive
    await this.probePages();

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

    // Prophylactic reload of provider pages (idle only) — prevents
    // long-lived pages from silently losing their backend connection
    await this.maybeReloadPages();

    // Persist status for CLI inspection (voicebridge status <id>)
    this.writeStatusFile();

    // Escalate unrecoverable states to a systemd-managed restart
    await this.maybeRestart();
  }

  private async probePages(): Promise<void> {
    const pair = this.browserManager.getPair();
    if (!pair) return;

    const probe = async (page: Page): Promise<boolean> => {
      try {
        await Promise.race([
          page.evaluate(() => document.title),
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
        return true;
      } catch {
        return false;
      }
    };

    const voiceOk = await probe(pair.voicePage);
    const aiOk = await probe(pair.aiPage);

    this.consecutiveVoiceProbeFailures = voiceOk ? 0 : this.consecutiveVoiceProbeFailures + 1;
    this.consecutiveAiProbeFailures = aiOk ? 0 : this.consecutiveAiProbeFailures + 1;

    this.status.voicePageResponsive = this.consecutiveVoiceProbeFailures < PROBE_FAILURE_THRESHOLD;
    this.status.aiPageResponsive = this.consecutiveAiProbeFailures < PROBE_FAILURE_THRESHOLD;

    if (!voiceOk) {
      this.logger.warn('Voice page probe failed', { consecutiveFailures: this.consecutiveVoiceProbeFailures });
    }
    if (!aiOk) {
      this.logger.warn('AI page probe failed', { consecutiveFailures: this.consecutiveAiProbeFailures });
    }
  }

  private async maybeReloadPages(): Promise<void> {
    if (this.status.inCall) return;
    const intervalMs = (this.config.pageReloadIntervalHours ?? 6) * 3600 * 1000;
    if (Date.now() - this.lastReloadAt < intervalMs) return;

    const pair = this.browserManager.getPair();
    if (!pair) return;

    this.logger.info('Prophylactic provider page reload starting');
    try {
      await pair.voicePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      const voiceLoggedIn = await this.voiceProvider.checkLoggedIn(pair.voicePage, this.logger);
      this.status.voiceLoggedIn = voiceLoggedIn;
      if (!voiceLoggedIn) throw new Error('voice provider not logged in after page reload');

      await pair.aiPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      const aiLoggedIn = await this.aiController.initialize(pair.aiPage, this.aiProvider);
      this.status.aiLoggedIn = aiLoggedIn;
      if (!aiLoggedIn) throw new Error('AI provider not logged in after page reload');

      this.lastReloadAt = Date.now();
      this.status.lastPageReload = new Date(this.lastReloadAt).toISOString();
      this.consecutiveVoiceProbeFailures = 0;
      this.consecutiveAiProbeFailures = 0;
      this.logger.info('Prophylactic provider page reload complete');
    } catch (err) {
      this.logger.error('Prophylactic page reload failed', { error: (err as Error).message });
      this.pendingRestart = `page reload failed: ${(err as Error).message}`;
    }
  }

  private async maybeRestart(): Promise<void> {
    if (!this.pendingRestart) {
      if (this.consecutiveVoiceProbeFailures >= PROBE_FAILURE_THRESHOLD) {
        this.pendingRestart = 'voice page unresponsive (consecutive probe failures)';
      } else if (this.consecutiveAiProbeFailures >= PROBE_FAILURE_THRESHOLD) {
        this.pendingRestart = 'AI page unresponsive (consecutive probe failures)';
      }
    }
    if (!this.pendingRestart) return;

    if (this.status.inCall) {
      this.logger.warn('Restart pending but call active — deferring', { reason: this.pendingRestart });
      return;
    }

    const reason = this.pendingRestart;
    this.logger.error('Fatal condition — restarting bridge via systemd', { reason });
    this.writeStatusFile([`restarting: ${reason}`]);
    await this.stop();
    process.exit(1);
  }

  private writeStatusFile(extraIssues: string[] = []): void {
    if (!this.statusWriter) return;
    this.statusWriter.write(this.getStatus(), [...computeCriticalIssues(this.status), ...extraIssues]);
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
      aiVoiceUnavailable: false,
      voicePageResponsive: true,
      aiPageResponsive: true,
    };
  }
}
