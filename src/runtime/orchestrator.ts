/**
 * BridgeOrchestrator — explicit call state machine connecting all modules.
 *
 * Recovery model (layered, bounded):
 *  1. A hung Playwright op is bounded by per-op timeouts (monitor/providers).
 *  2. A page that keeps timing out / failing probes is RECYCLED — closing the
 *     page rejects all outstanding protocol calls and a fresh page is created.
 *  3. If a page needs more than MAX_RECYCLES recycles inside RECYCLE_WINDOW,
 *     the process escalates to a systemd-managed restart (idle only — a call
 *     in progress is never interrupted by maintenance logic).
 *
 * Page refreshes are health-triggered (poll timeouts, DOM probe failures,
 * WebSocket liveness), never scheduled — no more 6-hour prophylactic crash.
 */

import { execFile } from 'child_process';
import type { BridgeConfig, BridgeStatus, BridgeState, CallInfo, AudioDevices, Page } from '../types';
import type { AudioPipeline } from './audio/pipeline';
import { SILENCE_RMS_THRESHOLD } from './audio/pipeline';
import type { BrowserManager, PageRole } from './browser/manager';
import type { VoiceMonitor, MonitorConfig } from './monitor';
import type { AIController } from './ai-controller';
import type { XvfbManager } from './xvfb';
import type { StatusFileWriter } from './status/writer';
import { CallMetricsWriter, CallTracker, type CallEndReason } from './metrics';
import type { VoiceProvider, AIProvider } from '../providers/contracts';
import type { Logger } from '../logger';

export { BridgeConfig, BridgeStatus };

/** Number of consecutive failed DOM probes before a page is recycled. */
const PROBE_FAILURE_THRESHOLD = 3;
/** Timeout for a single DOM probe (ms). */
const PROBE_TIMEOUT_MS = 5000;
/** Idle: recycle the voice page after this many consecutive poll timeouts. */
const IDLE_TIMEOUT_RECYCLE_THRESHOLD = 2;
/** In-call: tolerate more timeouts (audio flows independently of the DOM). */
const INCALL_TIMEOUT_RECYCLE_THRESHOLD = 12;
/** Recycle budget: at most this many per page within the window. */
const MAX_RECYCLES = 3;
const RECYCLE_WINDOW_MS = 30 * 60 * 1000;
/** Health ticks with zero open websockets before the voice page is declared deaf. */
const WS_DEAD_TICKS_THRESHOLD = 3;
/** Silent-audio sampling cadence while bridged. */
const AUDIO_SAMPLE_INTERVAL_MS = 10000;
/**
 * Delay before the first in-call audio sample. Grok's WebRTC peer often
 * connects a few seconds after getUserMedia; sampling before the greeting
 * is a false "silent AI" and used to tear down a working session.
 */
const AUDIO_FIRST_SAMPLE_MS = 15000;
/** Consecutive silent samples before flagging / recovering. */
const SILENT_SAMPLE_THRESHOLD = 2;
/** Canary calls are hung up by the bridge after this long. */
const CANARY_HANGUP_MS = 30000;

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
  private state: BridgeState = 'INIT';
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private audioSampleTimer: ReturnType<typeof setInterval> | null = null;
  private devices: AudioDevices | null = null;
  private monitorConfig: MonitorConfig | null = null;
  private consecutiveVoiceProbeFailures = 0;
  private consecutiveAiProbeFailures = 0;
  private consecutiveVoicePollTimeouts = 0;
  private wsDeadTicks = 0;
  private silentAiSamples = 0;
  private silentCallerSamples = 0;
  private pendingRestart: string | null = null;
  private recycleTimestamps: Record<PageRole, number[]> = { voice: [], ai: [] };
  private callTracker: CallTracker | null = null;
  private callEndReason: CallEndReason = 'caller_ended';
  private aiRecoveredThisCall = false;
  private audioFirstSampleTimer: ReturnType<typeof setTimeout> | null = null;

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
    private metricsWriter?: CallMetricsWriter,
  ) {
    this.status = this.createDefaultStatus();
  }

  // ─── Public API ──────────────────────────────────────────

  async start(): Promise<void> {
    this.logger.info('Starting Bridge', this.config as unknown as Record<string, unknown>);

    // Chromium launch + login checks can exceed the runtime watchdog
    // period — extend it during startup, tighten again once READY.
    this.sdNotify('WATCHDOG_USEC=180000000');

    try {
      this.transition('SETUP_AUDIO');
      await this.setupAudio();

      if (this.config.headless) {
        await this.xvfbManager.start(this.config.displayNum || ':99');
      }

      this.transition('LAUNCH_BROWSERS');
      await this.launchBrowsers();

      this.transition('CHECK_LOGINS');
      await this.checkLogins();

      this.setupEventWiring();
      this.startHealthChecks();

      this.status.running = true;
      this.transition('IDLE');
      this.writeStatusFile();
      this.sdNotify('READY=1');
      this.sdNotify('WATCHDOG_USEC=45000000');
      this.logger.info('Bridge started successfully');
    } catch (err) {
      this.logger.error('Bridge startup failed', { error: (err as Error).message });
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping bridge...');
    this.transition('SHUTDOWN');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.stopAudioSampling();

    if (this.callTracker) {
      this.finishCallRecord('service_stop');
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

  getState(): BridgeState {
    return this.state;
  }

  // ─── State machine ───────────────────────────────────────

  private transition(to: BridgeState): void {
    if (this.state === to) return;
    this.logger.info(`State: ${this.state} -> ${to}`);
    this.state = to;
    this.status.state = to;
    this.writeStatusFile();
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

    this.monitorConfig = {
      authorizedNumbers: this.config.authorizedNumbers,
      authorizedNames: this.config.authorizedNames,
      autoAccept: this.config.autoAccept,
      pollInterval: this.config.pollInterval,
      acceptTimeoutMs: this.config.acceptTimeoutMs,
      acceptRetries: this.config.acceptRetries,
    };

    await this.voiceProvider.initialize(pair.voicePage, this.logger);
    await this.voiceMonitor.startMonitoring(pair.voicePage, this.voiceProvider, this.monitorConfig);

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
    this.voiceMonitor.on('acceptFailed', (call: CallInfo) =>
      this.onAcceptFailed(call).catch((err) =>
        this.logger.error('Error in onAcceptFailed', { error: (err as Error).message }),
      ),
    );
    this.voiceMonitor.on('pollTimeout', () =>
      this.onVoicePollTimeout().catch((err) =>
        this.logger.error('Error in onVoicePollTimeout', { error: (err as Error).message }),
      ),
    );
    this.voiceMonitor.on('error', (err: Error) =>
      this.logger.error('Voice monitor error', { error: err.message }),
    );
    this.logger.debug('Event wiring complete');
  }

  // ─── Call flow handlers ──────────────────────────────────

  private async onIncomingCall(call: CallInfo): Promise<void> {
    this.transition('INCOMING_CALL');
    this.logger.info(`Incoming call from ${call.callerName} (${call.phoneNumber})`);

    const isCanary = !!this.config.canaryNumber && call.phoneNumber === this.config.canaryNumber;
    this.callTracker = new CallTracker(this.config.instanceId, call.phoneNumber, call.callerName, isCanary);
    this.callEndReason = 'caller_ended';

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
    this.transition('ACCEPT_CALL');
    this.logger.info('Call accepted, activating AI voice mode...');
    this.status.inCall = true;
    this.status.currentCall = call;
    this.aiRecoveredThisCall = false;
    this.callTracker?.markAccepted();

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

      this.transition('ACTIVATE_AI');
      const verified = await this.ensureVoiceSession(true);

      // Assert audio routing now, then keep it asserted event-driven.
      this.assertAudioRouting();
      this.audioPipeline.startEventRouter(() => this.assertAudioRouting());
      this.startAudioSampling();

      // The call may have ended while activation/verification was in flight
      // (e.g. caller gave up) — never enter BRIDGED for a dead call.
      if (!this.status.inCall) {
        this.logger.info('Call ended during AI activation — skipping BRIDGED');
        return;
      }

      if (verified) {
        this.transition('BRIDGED');
      } else if (!this.status.voiceModeActive) {
        this.callEndReason = 'bridge_error';
        this.logger.error('AI voice mode activation returned false');
        this.writeStatusFile(['ai_activation_failed: voice mode could not be activated']);
      } else {
        this.callEndReason = 'ai_voice_unavailable';
        this.logger.error('AI voice session could not be verified after retry');
        this.writeStatusFile();
      }

      if (this.isCanaryCall()) {
        this.scheduleCanaryHangup();
      }
    } catch (err) {
      this.callEndReason = 'bridge_error';
      this.logger.error('Failed to activate AI voice mode', { error: (err as Error).message });
    }
  }

  private isCanaryCall(): boolean {
    return !!this.config.canaryNumber && this.status.currentCall?.phoneNumber === this.config.canaryNumber;
  }

  private scheduleCanaryHangup(): void {
    const timer = setTimeout(() => {
      (async () => {
        this.logger.info('Canary window elapsed — hanging up self-test call');
        const tracker = this.callTracker;
        if (tracker) {
          const pass = !tracker.silentAiAudio && !tracker.silentCallerAudio && !this.status.aiVoiceUnavailable;
          this.logger.info(`CANARY ${pass ? 'PASS' : 'FAIL'}`, {
            silentAiAudio: tracker.silentAiAudio,
            silentCallerAudio: tracker.silentCallerAudio,
            aiVoiceUnavailable: this.status.aiVoiceUnavailable,
          });
          if (!pass) this.writeStatusFile(['canary_failed: audio or AI session check failed']);
        }
        this.callEndReason = 'canary_complete';
        const pair = this.browserManager.getPair();
        if (pair) {
          try { await this.voiceProvider.declineCall(pair.voicePage, this.logger); } catch { /* best effort */ }
        }
      })().catch((err) => this.logger.error('Canary hangup failed', { error: (err as Error).message }));
    }, CANARY_HANGUP_MS);
    if (timer.unref) timer.unref();
  }

  private async onCallEnded(): Promise<void> {
    this.transition('CALL_ENDING');
    this.logger.info('Call ended, deactivating AI voice mode...');
    this.status.inCall = false;
    this.status.currentCall = undefined;

    this.audioPipeline.stopEventRouter();
    this.stopAudioSampling();

    try {
      const d = this.audioPipeline.deviceNames;
      await this.audioPipeline.setDefaultSource(`${d.voiceSink}.monitor`);
      this.logger.info(`Restored default source to ${d.voiceSink}.monitor`);
      await this.audioPipeline.setDefaultSink(d.voiceSink);
      this.logger.info(`Restored default sink to ${d.voiceSink}`);
    } catch (err) {
      this.logger.warn('Failed to restore default audio', { error: (err as Error).message });
    }

    this.transition('DEACTIVATE_AI');
    try {
      const pair = this.browserManager.getPair();
      if (!pair) throw new Error('Browser pair not available');
      await this.aiController.deactivateVoiceMode(pair.aiPage);
      this.status.voiceModeActive = false;
    } catch (err) {
      this.logger.error('Error deactivating AI voice mode', { error: (err as Error).message });
      this.status.voiceModeActive = false;
    }

    this.finishCallRecord(this.callEndReason);
    this.transition('IDLE');

    // Maintenance deferred while the call was active can proceed now
    if (this.pendingRestart) {
      await this.maybeRestart();
    } else if (!this.status.aiPageResponsive) {
      await this.recyclePage('ai', 'AI page unresponsive — recycling after call');
    } else {
      // Grok.com goes stale if left on the same conversation. A planned
      // recycle after every call gives the next caller a fresh session
      // and does not count against the emergency recycle budget.
      await this.recyclePage('ai', 'planned recycle after call', { countAgainstBudget: false });
    }
  }

  private async onAcceptFailed(call: CallInfo): Promise<void> {
    this.logger.error(`Accept failed for ${call.phoneNumber} — call was declined`, {
      acceptTimeoutMs: this.config.acceptTimeoutMs ?? 5000,
      acceptRetries: this.config.acceptRetries ?? 1,
    });
    this.finishCallRecord('accept_failed');
    this.status.inCall = false;
    this.status.currentCall = undefined;
    this.writeStatusFile([`accept_failed: could not answer ${call.phoneNumber} in time`]);
    this.transition('IDLE');
  }

  // ─── Layered recovery ────────────────────────────────────

  private async onVoicePollTimeout(): Promise<void> {
    this.consecutiveVoicePollTimeouts++;
    const threshold = this.status.inCall
      ? INCALL_TIMEOUT_RECYCLE_THRESHOLD
      : IDLE_TIMEOUT_RECYCLE_THRESHOLD;

    if (this.consecutiveVoicePollTimeouts < threshold) return;
    this.consecutiveVoicePollTimeouts = 0;

    if (this.status.inCall) {
      // The page can no longer even report call state — the call is lost to
      // us regardless; tear it down cleanly, then recover the page.
      this.callEndReason = 'bridge_error';
      await this.onCallEnded();
    }
    await this.recyclePage('voice', `voice page poll timeouts x${threshold}`);
  }

  /**
   * Activate Grok voice and verify a *new* session actually started.
   * When verification fails and `allowRecycle` is set, recycle the AI
   * page (fresh grok.com) and try once more — never interrupt a dead
   * session with a keyboard-toggle on the same stale page.
   */
  private async ensureVoiceSession(allowRecycle: boolean): Promise<boolean> {
    const pair = this.browserManager.getPair();
    if (!pair) {
      this.logger.error('Browser pair not available for AI voice activation');
      this.status.voiceModeActive = false;
      return false;
    }

    const activated = await this.aiController.activateVoiceMode(pair.aiPage);
    this.status.voiceModeActive = activated;
    if (!activated) {
      this.status.aiVoiceUnavailable = true;
      this.status.aiVoiceStatusDetail = 'AI voice mode activation returned false';
      this.writeStatusFile();
      return false;
    }

    if (!this.aiProvider.verifyVoiceSession) {
      this.status.aiVoiceUnavailable = false;
      this.status.aiVoiceStatusDetail = undefined;
      this.callTracker?.markBridged();
      return true;
    }

    let verified = await this.aiProvider.verifyVoiceSession(pair.aiPage, this.logger);
    if (!verified && allowRecycle && this.status.inCall) {
      this.logger.warn('Voice session not verified — recycling AI page and retrying');
      await this.recyclePage('ai', 'voice session did not start after activation');
      return this.status.voiceModeActive && !this.status.aiVoiceUnavailable;
    }

    if (verified) {
      if (this.status.aiVoiceUnavailable) {
        this.logger.info('AI voice session verified — clearing aiVoiceUnavailable');
      }
      this.status.aiVoiceUnavailable = false;
      this.status.aiVoiceStatusDetail = undefined;
      this.callTracker?.markBridged();
    } else {
      this.status.aiVoiceUnavailable = true;
      this.status.aiVoiceStatusDetail =
        'AI voice session did not start after activation (page recycled/retried if possible)';
      this.callEndReason = 'ai_voice_unavailable';
      this.logger.error('AI voice session verification failed', { detail: this.status.aiVoiceStatusDetail });
    }
    this.writeStatusFile();
    return verified;
  }

  private async recyclePage(
    role: PageRole,
    reason: string,
    opts: { countAgainstBudget?: boolean } = {},
  ): Promise<void> {
    const countAgainstBudget = opts.countAgainstBudget !== false;
    if (countAgainstBudget && !this.canRecycle(role)) {
      this.pendingRestart = `${role} page recycle budget exhausted (${MAX_RECYCLES} in ${RECYCLE_WINDOW_MS / 60000}min)`;
      this.logger.error('Recycle budget exhausted — escalating to restart', { role, reason });
      return;
    }

    this.logger.warn(`Recycling ${role} page`, { reason });
    try {
      if (role === 'voice') {
        await this.voiceMonitor.stopMonitoring();
        const page = await this.browserManager.recyclePage('voice');
        await this.voiceProvider.initialize(page, this.logger);
        const loggedIn = await this.voiceProvider.checkLoggedIn(page, this.logger);
        this.status.voiceLoggedIn = loggedIn;
        if (!loggedIn) {
          this.pendingRestart = 'voice provider not logged in after page recycle';
          return;
        }
        if (this.monitorConfig) {
          await this.voiceMonitor.startMonitoring(page, this.voiceProvider, this.monitorConfig);
        }
        this.consecutiveVoiceProbeFailures = 0;
        this.wsDeadTicks = 0;
        this.status.voicePageResponsive = true;
        this.status.voicePageRecycles = (this.status.voicePageRecycles ?? 0) + 1;
      } else {
        const page = await this.browserManager.recyclePage('ai');
        const loggedIn = await this.aiController.initialize(page, this.aiProvider);
        this.status.aiLoggedIn = loggedIn;
        if (!loggedIn) {
          this.pendingRestart = 'AI provider not logged in after page recycle';
          return;
        }
        this.consecutiveAiProbeFailures = 0;
        this.status.aiPageResponsive = true;
        this.status.aiPageRecycles = (this.status.aiPageRecycles ?? 0) + 1;
        // If a call is active, try to re-establish the AI session
        if (this.status.inCall) {
          await this.ensureVoiceSession(false);
        }
      }
      this.status.lastPageReload = new Date().toISOString();
      this.writeStatusFile();
      this.logger.info(`${role} page recycled successfully`);
    } catch (err) {
      this.logger.error(`Failed to recycle ${role} page`, { error: (err as Error).message });
      if (countAgainstBudget) {
        this.pendingRestart = `${role} page recycle failed: ${(err as Error).message}`;
      }
    }
  }

  private canRecycle(role: PageRole): boolean {
    const now = Date.now();
    const windowStart = now - RECYCLE_WINDOW_MS;
    this.recycleTimestamps[role] = this.recycleTimestamps[role].filter((t) => t > windowStart);
    if (this.recycleTimestamps[role].length >= MAX_RECYCLES) return false;
    this.recycleTimestamps[role].push(now);
    return true;
  }

  // ─── Audio routing + sampling ────────────────────────────

  private assertAudioRouting(): void {
    const voiceDir = this.config.defaultProfilePath;
    const aiDir = this.config.tempProfilePath;
    this.audioPipeline.fixStreamRouting(voiceDir, aiDir).catch((err) =>
      this.logger.error('Audio routing fix failed', { error: (err as Error).message }),
    );
    this.audioPipeline.fixSinkRouting(voiceDir, aiDir).catch((err) =>
      this.logger.error('Audio sink routing fix failed', { error: (err as Error).message }),
    );
  }

  private startAudioSampling(): void {
    this.stopAudioSampling();
    this.silentAiSamples = 0;
    this.silentCallerSamples = 0;
    const sample = () => {
      this.sampleAudioDirections().catch((err) =>
        this.logger.warn('Audio sampling failed', { error: (err as Error).message }),
      );
    };
    this.audioFirstSampleTimer = setTimeout(sample, AUDIO_FIRST_SAMPLE_MS);
    if (this.audioFirstSampleTimer.unref) this.audioFirstSampleTimer.unref();
    this.audioSampleTimer = setInterval(sample, AUDIO_SAMPLE_INTERVAL_MS);
    if (this.audioSampleTimer.unref) this.audioSampleTimer.unref();
  }

  private stopAudioSampling(): void {
    if (this.audioFirstSampleTimer) {
      clearTimeout(this.audioFirstSampleTimer);
      this.audioFirstSampleTimer = null;
    }
    if (this.audioSampleTimer) {
      clearInterval(this.audioSampleTimer);
      this.audioSampleTimer = null;
    }
  }

  private async sampleAudioDirections(): Promise<void> {
    if (!this.status.inCall || !this.callTracker) return;
    const d = this.audioPipeline.deviceNames;

    // caller→AI direction: voice browser output (monitored by voiceSource)
    const callerLevel = await this.audioPipeline.sampleAudioLevel(d.voiceSource);
    // AI→caller direction: AI browser output (monitored by aiSource)
    const aiLevel = await this.audioPipeline.sampleAudioLevel(d.aiSource);

    if (callerLevel !== null && callerLevel < SILENCE_RMS_THRESHOLD) this.silentCallerSamples++;
    else this.silentCallerSamples = 0;
    if (aiLevel !== null && aiLevel < SILENCE_RMS_THRESHOLD) this.silentAiSamples++;
    else this.silentAiSamples = 0;

    this.logger.debug('Audio levels sampled', { callerLevel, aiLevel });

    if (this.silentCallerSamples >= SILENT_SAMPLE_THRESHOLD && this.callTracker) {
      this.callTracker.silentCallerAudio = true;
    }
    if (this.silentAiSamples >= SILENT_SAMPLE_THRESHOLD && this.callTracker) {
      this.callTracker.silentAiAudio = true;
      this.logger.error('Silent AI audio detected — caller likely hears nothing', { aiLevel });
      this.writeStatusFile(['silent_ai_audio: no audio from AI to caller direction']);
      // Mid-call recycle is last-resort only. Grok often stays quiet
      // while listening; tearing the page down just as the greeting
      // starts is how callers waited 30s to hear anything.
      if (!this.aiRecoveredThisCall && this.status.inCall) {
        this.aiRecoveredThisCall = true;
        this.logger.warn('Silent AI persisted after greeting window — recycling once');
        await this.recyclePage('ai', 'silent AI audio during call');
      }
    }
  }

  private finishCallRecord(reason: CallEndReason): void {
    if (!this.callTracker || !this.metricsWriter) {
      this.callTracker = null;
      return;
    }
    const record = this.callTracker.finish(reason);
    this.metricsWriter.append(record);
    this.logger.info('Call record written', {
      phoneNumber: record.phoneNumber,
      endReason: reason,
      acceptLatencyMs: record.acceptLatencyMs,
      durationMs: record.durationMs,
    });
    this.callTracker = null;
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

    // Recycle pages that have proven unresponsive (idle only for voice;
    // AI page recycle during a call re-establishes the session)
    if (this.consecutiveVoiceProbeFailures >= PROBE_FAILURE_THRESHOLD) {
      if (this.status.inCall) {
        this.logger.warn('Voice page unresponsive but call active — poll timeout path will bound it');
      } else {
        await this.recyclePage('voice', 'voice page unresponsive (consecutive probe failures)');
      }
    }
    if (this.consecutiveAiProbeFailures >= PROBE_FAILURE_THRESHOLD) {
      if (this.status.inCall) {
        this.logger.warn('AI page unresponsive during call — will recycle after call ends');
      } else {
        await this.recyclePage('ai', 'AI page unresponsive (consecutive probe failures)');
      }
    }

    // WebSocket liveness — a Google Voice page with no open websockets is
    // deaf: it will never show an incoming call. Idle only.
    // grok.com is intentionally not checked: it often has zero CDP-visible
    // websockets (HTTP/2 / sockets opened before Network.enable), and
    // recycling it every 30s exhausted the budget and restarted the
    // service — then delayed the next call by another full grok.com load.
    if (!this.status.inCall && this.status.running) {
      const openWs = this.browserManager.getOpenWebSocketCount('voice');
      if (openWs === 0) {
        this.wsDeadTicks++;
        if (this.wsDeadTicks >= WS_DEAD_TICKS_THRESHOLD) {
          this.wsDeadTicks = 0;
          await this.recyclePage('voice', 'voice page has no open websockets (backend connection lost)');
        }
      } else {
        this.wsDeadTicks = 0;
      }
    }

    // Persist status for CLI inspection (voicebridge status <id>)
    this.writeStatusFile();

    // Feed the systemd watchdog every healthy tick
    this.sdNotify('WATCHDOG=1');

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

  private async maybeRestart(): Promise<void> {
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

  /** Best-effort sd_notify; no-op when not running under systemd. */
  private sdNotify(message: string): void {
    if (!process.env.NOTIFY_SOCKET) return;
    // --pid: the notification must be attributed to the service's main PID,
    // otherwise NotifyAccess=main silently drops it.
    execFile('systemd-notify', [`--pid=${process.pid}`, message], () => { /* best effort */ });
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
      state: this.state,
      voicePageRecycles: 0,
      aiPageRecycles: 0,
    };
  }
}
