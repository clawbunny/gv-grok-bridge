import type { AudioDevices } from '../types';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';

/** Args for one PulseAudio module to load in the bidirectional pipeline. */
interface ModuleDef {
  name: string;
  module: string;
  args: string;
}

/** The four modules that form the bidirectional audio bridge. */
const MODULES: ModuleDef[] = [
  {
    name: 'gvSink',
    module: 'module-null-sink',
    args: 'sink_name=pipe_gv_to_grok format=float32le sink_properties="device.description=\'GV_Out_to_Grok_In\'"',
  },
  {
    name: 'grokSink',
    module: 'module-null-sink',
    args: 'sink_name=pipe_grok_to_gv format=float32le sink_properties="device.description=\'Grok_Out_to_GV_In\'"',
  },
  {
    name: 'gvSource',
    module: 'module-remap-source',
    args: 'master=pipe_gv_to_grok.monitor source_name=src_gv_to_grok source_properties="device.description=\'GV_Audio_to_Grok_Mic\'"',
  },
  {
    name: 'grokSource',
    module: 'module-remap-source',
    args: 'master=pipe_grok_to_gv.monitor source_name=src_grok_to_gv source_properties="device.description=\'Grok_Audio_to_GV_Mic\'"',
  },
];

export class AudioPipeline {
  constructor(
    private exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
    private logger: Logger = new SilentLogger()
  ) {}

  /** Execute a shell command via the injected executor. */
  private async execPromise(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec(cmd);
  }

  /** Load a PulseAudio module and return its numeric module ID. */
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

  /** Unload a PulseAudio module by its numeric module ID. */
  private async unloadModule(moduleId: number): Promise<void> {
    await this.execPromise(`pactl unload-module ${moduleId}`);
  }

  /**
   * Ensure PulseAudio is running.
   * If `pactl info` fails, try `pulseaudio --start` once.
   * Throw a descriptive error if PulseAudio still cannot be reached.
   */
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

  /** Unload any previously-loaded bridge modules to avoid duplicates. */
  private async cleanupExistingModules(): Promise<void> {
    const markers = ['pipe_gv_to_grok', 'pipe_grok_to_gv', 'src_gv_to_grok', 'src_grok_to_gv'];
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

  /** Set up the bidirectional audio pipeline. */
  async setup(): Promise<AudioDevices> {
    this.logger.info('Setting up audio pipeline');
    await this.ensurePulseAudio();
    await this.cleanupExistingModules();

    const ids: number[] = [];
    for (const mod of MODULES) {
      this.logger.info(`Loading ${mod.name} (${mod.module})`);
      const id = await this.loadModule(mod.module, mod.args);
      this.logger.info(`  -> ${mod.name} module ID: ${id}`);
      ids.push(id);
    }

    const devices: AudioDevices = {
      gvSink: ids[0],
      grokSink: ids[1],
      gvSource: ids[2],
      grokSource: ids[3],
    };

    await this.setSinkVolumes();

    this.logger.info('Audio pipeline ready', { ...devices });
    return devices;
  }

  /** Set both virtual sinks to 70% volume to create AGC headroom. */
  private async setSinkVolumes(): Promise<void> {
    const sinks = ['pipe_gv_to_grok', 'pipe_grok_to_gv'];
    const volume = Math.round(65536 * 0.7); // ~70% ≈ -3 dB
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

  /**
   * Find the PID of a Chromium process by its --user-data-dir argument.
   */
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

  /**
   * Look up the current numeric PulseAudio source ID by its name.
   */
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

  /**
   * Fix Chromium source-output routing so each browser records from the
   * correct virtual source.
   */
  async fixStreamRouting(gvUserDataDir: string, grokUserDataDir: string): Promise<void> {
    const gvPid = await this.findChromiumPid(gvUserDataDir);
    const grokPid = await this.findChromiumPid(grokUserDataDir);
    const srcGrokToGv = await this.findSourceId('src_grok_to_gv');
    const srcGvToGrok = await this.findSourceId('src_gv_to_grok');

    if (!gvPid || !grokPid || !srcGrokToGv || !srcGvToGrok) {
      this.logger.warn('Could not find Chromium PIDs or source IDs for stream routing');
      return;
    }

    this.logger.debug(`Routing streams: gvPid=${gvPid}, grokPid=${grokPid}, srcGrokToGv=${srcGrokToGv}, srcGvToGrok=${srcGvToGrok}`);

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
      if (clientId === '-') continue; // internal streams
      if (Number.isNaN(sourceOutputId)) continue;

      // Get detailed info to find the PID
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
      if (streamPid === gvPid && currentSource !== srcGrokToGv) {
        targetSource = srcGrokToGv;
      } else if (streamPid === grokPid && currentSource !== srcGvToGrok) {
        targetSource = srcGvToGrok;
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

  /** Tear down the audio pipeline by unloading all four PulseAudio modules. */
  async teardown(devices: AudioDevices): Promise<void> {
    this.logger.info('Tearing down audio pipeline');

    const modules = [
      { name: 'gvSink (pipe_gv_to_grok)', id: devices.gvSink },
      { name: 'grokSink (pipe_grok_to_gv)', id: devices.grokSink },
      { name: 'gvSource (src_gv_to_grok)', id: devices.gvSource },
      { name: 'grokSource (src_grok_to_gv)', id: devices.grokSource },
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
