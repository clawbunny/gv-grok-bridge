/**
 * AudioPipeline — manages PulseAudio virtual audio devices per instance.
 * Namespaced so multiple instances can coexist without collision.
 */

import type { AudioDevices } from '../../types';
import type { Logger } from '../../logger';
import { SilentLogger } from '../../logger';

interface ModuleDef {
  name: string;
  module: string;
  args: string;
}

export class AudioPipeline {
  private namespace: string;
  private exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  private logger: Logger;

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

  async setDefaultSource(sourceName: string): Promise<void> {
    await this.execPromise(`pactl set-default-source ${sourceName}`);
    this.logger.debug(`Set default PulseAudio source to ${sourceName}`);
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

  private async findChromiumPid(userDataDir: string): Promise<number | null> {
    try {
      const { stdout } = await this.execPromise(
        `ps aux | grep 'chromium' | grep 'user-data-dir=${userDataDir}' | grep -v grep | awk '{print $2}' | head -1`
      );
      const pid = parseInt(stdout.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
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

  async fixStreamRouting(voiceUserDataDir: string, aiUserDataDir: string): Promise<void> {
    const d = this.deviceNames;
    const voicePid = await this.findChromiumPid(voiceUserDataDir);
    const aiPid = await this.findChromiumPid(aiUserDataDir);
    const srcAiToVoice = await this.findSourceId(d.aiSource);
    const srcVoiceToAi = await this.findSourceId(d.voiceSource);

    if (!voicePid || !aiPid || !srcAiToVoice || !srcVoiceToAi) {
      this.logger.warn('Could not find Chromium PIDs or source IDs for stream routing');
      return;
    }

    this.logger.debug(`Routing streams: voicePid=${voicePid}, aiPid=${aiPid}, srcAiToVoice=${srcAiToVoice}, srcVoiceToAi=${srcVoiceToAi}`);

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
      const clientId = parts[2];
      if (clientId === '-') continue;
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

  async teardown(devices: AudioDevices): Promise<void> {
    this.logger.info('Tearing down audio pipeline');

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
