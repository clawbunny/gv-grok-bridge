/// <reference types="jest" />
import { AudioPipeline } from '../pipeline';
import type { Logger } from '../../logger';
import type { AudioDevices } from '../../types';

/** Mock executor that tracks calls and returns configurable responses. */
function createMockExec() {
  const calls: string[] = [];
  const responses: Map<string, { stdout: string; stderr: string }> = new Map();
  const errors: Map<string, Error> = new Map();

  const mockExec = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    calls.push(cmd);
    if (errors.has(cmd)) throw errors.get(cmd)!;
    const response = responses.get(cmd);
    if (response) return response;
    // Default: pactl info succeeds
    if (cmd === 'pactl info') return { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' };
    // Default: load-module returns a module ID based on cmd content
    if (cmd.startsWith('pactl load-module')) {
      // deterministic pseudo-id from the module name
      const mod = cmd.split(' ')[2];
      const id = mod === 'module-null-sink' ? 10 : 11;
      return { stdout: String(id), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  return { mockExec, calls, responses, errors };
}

/** No-op logger for clean test output. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('AudioPipeline', () => {
  describe('setup()', () => {
    it('loads all 4 PulseAudio modules and returns AudioDevices with numeric IDs', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' });
      let nextId = 22;
      // cleanupExistingModules calls pactl list modules short first
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_gv_to_grok format=float32le sink_properties="device.description=\'GV_Out_to_Grok_In\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_grok_to_gv format=float32le sink_properties="device.description=\'Grok_Out_to_GV_In\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-remap-source master=pipe_gv_to_grok.monitor source_name=src_gv_to_grok source_properties="device.description=\'GV_Audio_to_Grok_Mic\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-remap-source master=pipe_grok_to_gv.monitor source_name=src_grok_to_gv source_properties="device.description=\'Grok_Audio_to_GV_Mic\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl set-sink-volume pipe_gv_to_grok 45875', { stdout: '', stderr: '' });
      responses.set('pactl set-sink-volume pipe_grok_to_gv 45875', { stdout: '', stderr: '' });

      const pipeline = new AudioPipeline(mockExec, silentLogger);
      const devices: AudioDevices = await pipeline.setup();

      expect(devices.gvSink).toBe(22);
      expect(devices.grokSink).toBe(23);
      expect(devices.gvSource).toBe(24);
      expect(devices.grokSource).toBe(25);

      // Verify 4 load-module calls were made
      const loadCalls = calls.filter(c => c.startsWith('pactl load-module'));
      expect(loadCalls).toHaveLength(4);
    });

    it('calls ensurePulseAudio() first (pactl info before load-module)', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' });
      let nextId = 1;
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_gv_to_grok format=float32le sink_properties="device.description=\'GV_Out_to_Grok_In\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_grok_to_gv format=float32le sink_properties="device.description=\'Grok_Out_to_GV_In\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-remap-source master=pipe_gv_to_grok.monitor source_name=src_gv_to_grok source_properties="device.description=\'GV_Audio_to_Grok_Mic\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl load-module module-remap-source master=pipe_grok_to_gv.monitor source_name=src_grok_to_gv source_properties="device.description=\'Grok_Audio_to_GV_Mic\'"', { stdout: String(nextId++), stderr: '' });
      responses.set('pactl set-sink-volume pipe_gv_to_grok 45875', { stdout: '', stderr: '' });
      responses.set('pactl set-sink-volume pipe_grok_to_gv 45875', { stdout: '', stderr: '' });

      const pipeline = new AudioPipeline(mockExec, silentLogger);
      await pipeline.setup();

      const infoIdx = calls.indexOf('pactl info');
      const firstLoadIdx = calls.findIndex(c => c.startsWith('pactl load-module'));
      expect(infoIdx).toBeLessThan(firstLoadIdx);
    });

    it('rejects if any module fails to load', async () => {
      const { mockExec, responses, errors } = createMockExec();
      responses.set('pactl info', { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' });
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_gv_to_grok format=float32le sink_properties="device.description=\'GV_Out_to_Grok_In\'"', { stdout: '28', stderr: '' });
      errors.set(
        'pactl load-module module-null-sink sink_name=pipe_grok_to_gv format=float32le sink_properties="device.description=\'Grok_Out_to_GV_In\'"',
        new Error('Failure')
      );

      const pipeline = new AudioPipeline(mockExec, silentLogger);
      await expect(pipeline.setup()).rejects.toThrow();
    });
  });

  describe('teardown()', () => {
    it('unloads all 4 modules by ID', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'ok', stderr: '' });

      const devices: AudioDevices = { gvSink: 10, grokSink: 11, gvSource: 12, grokSource: 13 };
      const pipeline = new AudioPipeline(mockExec, silentLogger);
      await pipeline.teardown(devices);

      expect(calls).toContain('pactl unload-module 10');
      expect(calls).toContain('pactl unload-module 11');
      expect(calls).toContain('pactl unload-module 12');
      expect(calls).toContain('pactl unload-module 13');
    });

    it('continues even if one module fails to unload', async () => {
      const { mockExec, calls, errors } = createMockExec();
      errors.set('pactl unload-module 11', new Error('No such module'));

      const devices: AudioDevices = { gvSink: 10, grokSink: 11, gvSource: 12, grokSource: 13 };
      const pipeline = new AudioPipeline(mockExec, silentLogger);

      // Should not throw
      await expect(pipeline.teardown(devices)).resolves.toBeUndefined();

      // All 4 unload attempts should still have been made
      expect(calls).toContain('pactl unload-module 10');
      expect(calls).toContain('pactl unload-module 11');
      expect(calls).toContain('pactl unload-module 12');
      expect(calls).toContain('pactl unload-module 13');
    });
  });

  describe('ensurePulseAudio()', () => {
    it('returns immediately if pactl info succeeds', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' });

      const pipeline = new AudioPipeline(mockExec, silentLogger);
      await pipeline.ensurePulseAudio();

      expect(calls).toContain('pactl info');
      expect(calls).not.toContain('pulseaudio --start');
    });

    it('tries pulseaudio --start if pactl fails', async () => {
      const { mockExec, calls, responses, errors } = createMockExec();
      errors.set('pactl info', new Error('Connection refused'));
      responses.set('pulseaudio --start', { stdout: '', stderr: '' });
      responses.set('pactl load-module module-null-sink sink_name=pipe_gv_to_grok sink_properties="device.description=\'GV_Out_to_Grok_In\'"', { stdout: '22', stderr: '' });
      // After pulseaudio --start, pactl info succeeds
      let callCount = 0;
      const originalMockExec = mockExec;
      const trackingExec = async (cmd: string) => {
        if (cmd === 'pactl info') {
          callCount++;
          if (callCount <= 1) throw new Error('Connection refused');
          return { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' };
        }
        return originalMockExec(cmd);
      };

      const pipeline = new AudioPipeline(trackingExec, silentLogger);
      await pipeline.ensurePulseAudio();

      expect(calls).toContain('pulseaudio --start');
    });

    it('throws descriptive error if PulseAudio cannot be reached', async () => {
      const { mockExec } = createMockExec();
      let callCount = 0;
      const alwaysFailingExec = async (cmd: string) => {
        if (cmd === 'pactl info') {
          callCount++;
          throw new Error('Connection refused');
        }
        if (cmd === 'pulseaudio --start') {
          throw new Error('pulseaudio: command not found');
        }
        return { stdout: '', stderr: '' };
      };

      const pipeline = new AudioPipeline(alwaysFailingExec, silentLogger);
      await expect(pipeline.ensurePulseAudio()).rejects.toThrow(/PulseAudio is not running/);
    });
  });
});
