/**
 * AudioPipeline — manages PulseAudio virtual audio devices per instance.
 * Namespaced so multiple instances can coexist without collision.
 *
 * Stream routing matches streams by the PulseAudio `application.name`
 * property (set at browser launch via PULSE_PROP_application_name), not by
 * scraping PIDs from `ps` — PIDs change on renderer restarts, the property
 * does not.
 *
 * Routing is re-asserted event-driven: a `pactl subscribe` listener fires
 * when streams appear/move, replacing the old fixed 2s/8s/10s re-fix timers.
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import type { AudioDevices } from '../../types';
import type { Logger } from '../../logger';
import { SilentLogger } from '../../logger';

interface ModuleDef {
  name: string;
  module: string;
  args: string;
}

/** RMS below this (int16 scale) counts as silence. */
const SILENCE_RMS_THRESHOLD = 100;

export class AudioPipeline {
  private namespace: string;
  private exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  private logger: Logger;
  private routerProcess: ChildProcess | null = null;
  private routerStopped = true;
  private routerRestartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    namespace: string,
    exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
    logger: Logger = new SilentLogger(),
  ) {
    this.namespace = namespace;
    this.exec = exec;
    this.logger = logger;
  }

  private async execPromise(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec(cmd);
  }

  get deviceNames() {
    const ns = this.namespace;
    return {
      voiceSink: `pipe_voice_to_ai_${ns}`,
      aiSink: `pipe_ai_to_voice_${ns}`,
      voiceSource: `src_voice_to_ai_${ns}`,
      aiSource: `src_ai_to_voice_${ns}`,
    };
  }

  /** PulseAudio application.name values set on each browser at launch. */
  get appNames() {
    return {
      voice: `Chromium-Voice-${this.namespace}`,
      ai: `Chromium-AI-${this.namespace}`,
    };
  }

  async setDefaultSource(sourceName: string): Promise<void> {
    await this.execPromise(`pactl set-default-source ${sourceName}`);
    this.logger.debug(`Set default PulseAudio source to ${sourceName}`);
  }

  async setDefaultSink(sinkName: string): Promise<void> {
    await this.execPromise(`pactl set-default-sink ${sinkName}`);
    this.logger.debug(`Set default PulseAudio sink to ${sinkName}`);
  }

  private getModules(): ModuleDef[] {
    const d = this.deviceNames;
    return [
      {
        name: 'voiceSink',
        module: 'module-null-sink',
        args: `sink_name=${d.voiceSink} format=float32le sink_properties="device.description='Voice_Out_to_AI_In_${this.namespace}'"`,
      },
      {
        name: 'aiSink',
        module: 'module-null-sink',
        args: `sink_name=${d.aiSink} format=float32le sink_properties="device.description='AI_Out_to_Voice_In_${this.namespace}'"`,
      },
      {
        name: 'voiceSource',
        module: 'module-remap-source',
        args: `master=${d.voiceSink}.monitor source_name=${d.voiceSource} source_properties="device.description='Voice_Audio_to_AI_Mic_${this.namespace}'"`,
      },
      {
        name: 'aiSource',
        module: 'module-remap-source',
        args: `master=${d.aiSink}.monitor source_name=${d.aiSource} source_properties="device.description='AI_Audio_to_Voice_Mic_${this.namespace}'"`,
      },
    ];
  }

  private async loadModule(module: string, args: string): Promise<number> {
    const { stdout } = await this.execPromise(`pactl load-module ${module} ${args}`);
    const moduleId = parseInt(stdout.trim(), 10);
    if (Number.isNaN(moduleId)) {
      throw new Error(
        `Failed to parse module ID from "pactl load-module ${module}". Output was: "${stdout.trim()}"`
      );
    }
    return moduleId;
  }

  private async unloadModule(moduleId: number): Promise<void> {
    await this.execPromise(`pactl unload-module ${moduleId}`);
  }

  async ensurePulseAudio(): Promise<void> {
    try {
      await this.execPromise('pactl info');
      return;
    } catch {
      this.logger.info('PulseAudio not running, attempting to start...');
    }

    try {
      await this.execPromise('pulseaudio --start');
    } catch {
      // --start failed; will validate below
    }

    try {
      await this.execPromise('pactl info');
      this.logger.info('PulseAudio started successfully.');
    } catch {
      throw new Error(
        'PulseAudio is not running and could not be started. ' +
          'Please install PulseAudio (e.g., "sudo apt install pulseaudio") ' +
          'and ensure it is available in your PATH.'
      );
    }
  }

  private async cleanupExistingModules(): Promise<void> {
    const d = this.deviceNames;
    const markers = [d.voiceSink, d.aiSink, d.voiceSource, d.aiSource];
    let stdout: string;
    try {
      ({ stdout } = await this.execPromise('pactl list modules short'));
    } catch {
      return;
    }

    const ids: number[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+/);
      if (!match) continue;
      const moduleId = parseInt(match[1], 10);
      for (const marker of markers) {
        if (line.includes(marker) && !Number.isNaN(moduleId)) {
          ids.push(moduleId);
          break;
        }
      }
    }

    for (const id of ids) {
      try {
        await this.unloadModule(id);
        this.logger.debug(`Unloaded stale module ${id}`);
      } catch {
        // ignore
      }
    }
  }

  async setup(): Promise<AudioDevices> {
    this.logger.info(`Setting up audio pipeline (namespace: ${this.namespace})`);
    await this.ensurePulseAudio();
    await this.cleanupExistingModules();

    const modules = this.getModules();
    const ids: number[] = [];
    for (const mod of modules) {
      this.logger.info(`Loading ${mod.name} (${mod.module})`);
      const id = await this.loadModule(mod.module, mod.args);
      this.logger.info(`  -> ${mod.name} module ID: ${id}`);
      ids.push(id);
    }

    const devices: AudioDevices = {
      voiceSink: ids[0],
      aiSink: ids[1],
      voiceSource: ids[2],
      aiSource: ids[3],
    };

    await this.setSinkVolumes();

    this.logger.info('Audio pipeline ready', { ...devices });
    return devices;
  }

  private async setSinkVolumes(): Promise<void> {
    const d = this.deviceNames;
    const sinks = [d.voiceSink, d.aiSink];
    const volume = Math.round(65536 * 0.7);
    for (const sink of sinks) {
      try {
        await this.execPromise(`pactl set-sink-volume ${sink} ${volume}`);
        this.logger.debug(`Set ${sink} volume to 70%`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to set volume for ${sink}: ${message}`);
      }
    }
  }

  private async findSourceId(name: string): Promise<number | null> {
    try {
      const { stdout } = await this.execPromise('pactl list sources short');
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === name) {
          const id = parseInt(parts[0], 10);
          return Number.isNaN(id) ? null : id;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async findSinkId(name: string): Promise<number | null> {
    try {
      const { stdout } = await this.execPromise('pactl list sinks short');
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === name) {
          const id = parseInt(parts[0], 10);
          return Number.isNaN(id) ? null : id;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Resolve the MAIN Chromium process PID for a profile dir by scanning
   * /proc (no ps, no shell). The main process owns the audio streams
   * (AudioServiceOutOfProcess is disabled); renderer/gpu/utility children
   * carry --type= and are skipped.
   * Necessary because Chromium ignores PULSE_PROP_* and always reports
   * application.name="Chromium" for both browsers — the PID is the only
   * reliable way to tell their streams apart.
   */
  private async findMainChromiumPid(userDataDir: string): Promise<number | null> {
    let entries: string[];
    try {
      entries = await fsp.readdir('/proc');
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf-8');
        if (!cmdline.includes(`user-data-dir=${userDataDir}`)) continue;
        if (cmdline.includes('--type=')) continue;
        return parseInt(entry, 10);
      } catch {
        continue;
      }
    }
    return null;
  }

  async fixStreamRouting(voiceUserDataDir: string, aiUserDataDir: string): Promise<void> {
    const d = this.deviceNames;
    const voicePid = await this.findMainChromiumPid(voiceUserDataDir);
    const aiPid = await this.findMainChromiumPid(aiUserDataDir);
    const srcAiToVoice = await this.findSourceId(d.aiSource);
    const srcVoiceToAi = await this.findSourceId(d.voiceSource);

    if (!voicePid || !aiPid || !srcAiToVoice || !srcVoiceToAi) {
      this.logger.warn('Could not find Chromium PIDs or source IDs for stream routing');
      return;
    }

    let stdout: string;
    try {
      ({ stdout } = await this.execPromise('pactl list source-outputs short'));
    } catch {
      return;
    }

    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const sourceOutputId = parseInt(parts[0], 10);
      const currentSource = parseInt(parts[1], 10);
      if (parts[2] === '-') continue;
      if (Number.isNaN(sourceOutputId)) continue;

      let detail: string;
      try {
        ({ stdout: detail } = await this.execPromise(`pactl list source-outputs | grep -A 25 'Source Output #${sourceOutputId}'`));
      } catch {
        continue;
      }

      const pidMatch = detail.match(/application\.process\.id\s*=\s*"(\d+)"/);
      if (!pidMatch) continue;
      const streamPid = parseInt(pidMatch[1], 10);

      let targetSource: number | null = null;
      if (streamPid === voicePid && currentSource !== srcAiToVoice) {
        targetSource = srcAiToVoice;
      } else if (streamPid === aiPid && currentSource !== srcVoiceToAi) {
        targetSource = srcVoiceToAi;
      }

      if (targetSource !== null) {
        try {
          await this.execPromise(`pactl move-source-output ${sourceOutputId} ${targetSource}`);
          this.logger.info(`Moved source-output ${sourceOutputId} (PID ${streamPid}) to source ${targetSource}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to move source-output ${sourceOutputId}: ${message}`);
        }
      }
    }
  }

  async fixSinkRouting(voiceUserDataDir: string, aiUserDataDir: string): Promise<void> {
    const d = this.deviceNames;
    const voicePid = await this.findMainChromiumPid(voiceUserDataDir);
    const aiPid = await this.findMainChromiumPid(aiUserDataDir);
    const sinkVoice = await this.findSinkId(d.voiceSink);
    const sinkAi = await this.findSinkId(d.aiSink);

    if (!voicePid || !aiPid || !sinkVoice || !sinkAi) {
      this.logger.warn('Could not find Chromium PIDs or sink IDs for sink routing');
      return;
    }

    let stdout: string;
    try {
      ({ stdout } = await this.execPromise('pactl list sink-inputs short'));
    } catch {
      return;
    }

    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const sinkInputId = parseInt(parts[0], 10);
      const currentSink = parseInt(parts[1], 10);
      if (parts[2] === '-') continue;
      if (Number.isNaN(sinkInputId)) continue;

      let detail: string;
      try {
        ({ stdout: detail } = await this.execPromise(`pactl list sink-inputs | grep -A 25 'Sink Input #${sinkInputId}'`));
      } catch {
        continue;
      }

      const pidMatch = detail.match(/application\.process\.id\s*=\s*"(\d+)"/);
      if (!pidMatch) continue;
      const streamPid = parseInt(pidMatch[1], 10);

      let targetSink: number | null = null;
      if (streamPid === voicePid && currentSink !== sinkVoice) {
        targetSink = sinkVoice;
      } else if (streamPid === aiPid && currentSink !== sinkAi) {
        targetSink = sinkAi;
      }

      if (targetSink !== null) {
        try {
          await this.execPromise(`pactl move-sink-input ${sinkInputId} ${targetSink}`);
          this.logger.info(`Moved sink-input ${sinkInputId} (PID ${streamPid}) to sink ${targetSink}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to move sink-input ${sinkInputId}: ${message}`);
        }
      }
    }
  }

  // ─── Event-driven routing re-assertion ───────────────────

  /**
   * Start listening to PulseAudio subscription events. Whenever a sink-input
   * or source-output appears or changes, `onStreamEvent` fires (debounced).
   * The listener respawns automatically with backoff if pactl exits.
   */
  startEventRouter(onStreamEvent: () => void): void {
    this.routerStopped = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const spawnListener = () => {
      if (this.routerStopped) return;
      let child: ChildProcess;
      try {
        child = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (err) {
        this.logger.error('Failed to spawn pactl subscribe', { error: (err as Error).message });
        this.scheduleRouterRestart(spawnListener, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
        return;
      }
      this.routerProcess = child;

      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (/on (sink-input|source-output) #/.test(line)) {
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => { pending = null; onStreamEvent(); }, 500);
            if (pending.unref) pending.unref();
          }
        }
      });

      child.on('exit', (code) => {
        this.routerProcess = null;
        if (this.routerStopped) return;
        this.logger.warn(`pactl subscribe exited (code ${code}) — respawning in ${backoffMs}ms`);
        this.scheduleRouterRestart(spawnListener, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
      });

      backoffMs = 1000;
      this.logger.debug('Audio event router started');
    };

    spawnListener();
  }

  private scheduleRouterRestart(restart: () => void, delayMs: number): void {
    if (this.routerStopped) return;
    this.routerRestartTimer = setTimeout(() => {
      this.routerRestartTimer = null;
      restart();
    }, delayMs);
    if (this.routerRestartTimer.unref) this.routerRestartTimer.unref();
  }

  stopEventRouter(): void {
    this.routerStopped = true;
    if (this.routerRestartTimer) {
      clearTimeout(this.routerRestartTimer);
      this.routerRestartTimer = null;
    }
    if (this.routerProcess) {
      try { this.routerProcess.kill(); } catch { /* ignore */ }
      this.routerProcess = null;
    }
  }

  // ─── Audio level sampling (silent-call detection) ────────

  /**
   * Sample ~1.5 s of audio from the given source and return its RMS level
   * (int16 scale, 0–32767). Returns null when sampling fails.
   */
  async sampleAudioLevel(sourceName: string): Promise<number | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let child: ChildProcess;
      try {
        child = spawn('parec', [
          `--device=${sourceName}`,
          '--format=s16le',
          '--rate=16000',
          '--channels=1',
          '--latency-msec=100',
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(null);
        return;
      }

      const done = (value: number | null) => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(value);
      };

      const timer = setTimeout(() => {
        if (chunks.length === 0) { done(null); return; }
        done(rmsOfBuffers(chunks));
      }, 1500);
      if (timer.unref) timer.unref();

      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (chunks.length === 0) { done(null); return; }
        done(rmsOfBuffers(chunks));
      });
    });
  }

  async teardown(devices: AudioDevices): Promise<void> {
    this.logger.info('Tearing down audio pipeline');
    this.stopEventRouter();

    const modules = [
      { name: 'voiceSink', id: devices.voiceSink },
      { name: 'aiSink', id: devices.aiSink },
      { name: 'voiceSource', id: devices.voiceSource },
      { name: 'aiSource', id: devices.aiSource },
    ];

    for (const mod of modules) {
      try {
        this.logger.info(`Unloading module ${mod.name} (ID: ${mod.id})`);
        await this.unloadModule(mod.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to unload ${mod.name} (ID: ${mod.id}): ${message}`);
      }
    }

    this.logger.info('Audio pipeline teardown complete');
  }
}

/** Compute RMS over concatenated int16-LE PCM buffers. */
export function rmsOfBuffers(chunks: Buffer[]): number {
  let sumSquares = 0;
  let count = 0;
  for (const chunk of chunks) {
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      sumSquares += sample * sample;
      count++;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sumSquares / count);
}

export { SILENCE_RMS_THRESHOLD };
