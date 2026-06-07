/// <reference types="jest" />
import { AudioPipeline } from '../pipeline';
import type { Logger } from '../../../logger';
import type { AudioDevices } from '../../../types';

function createMockExec() {
  const calls: string[] = [];
  const responses: Map<string, { stdout: string; stderr: string }> = new Map();
  const errors: Map<string, Error> = new Map();

  const mockExec = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    calls.push(cmd);
    if (errors.has(cmd)) throw errors.get(cmd)!;
    const response = responses.get(cmd);
    if (response) return response;
    if (cmd === 'pactl info') return { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' };
    if (cmd.startsWith('pactl load-module')) {
      const mod = cmd.split(' ')[2];
      const id = mod === 'module-null-sink' ? 10 : 11;
      return { stdout: String(id), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  return { mockExec, calls, responses, errors };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('AudioPipeline (namespaced)', () => {
  const NAMESPACE = 'test_ns';

  describe('setup()', () => {
    it('loads all 4 PulseAudio modules with namespaced device names', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'Server String: /run/user/1000/pulse/native\n', stderr: '' });
      let nextId = 22;
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      responses.set(`pactl load-module module-null-sink sink_name=pipe_voice_to_ai_${NAMESPACE} format=float32le sink_properties="device.description='Voice_Out_to_AI_In_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-null-sink sink_name=pipe_ai_to_voice_${NAMESPACE} format=float32le sink_properties="device.description='AI_Out_to_Voice_In_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-remap-source master=pipe_voice_to_ai_${NAMESPACE}.monitor source_name=src_voice_to_ai_${NAMESPACE} source_properties="device.description='Voice_Audio_to_AI_Mic_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-remap-source master=pipe_ai_to_voice_${NAMESPACE}.monitor source_name=src_ai_to_voice_${NAMESPACE} source_properties="device.description='AI_Audio_to_Voice_Mic_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl set-sink-volume pipe_voice_to_ai_${NAMESPACE} 45875`, { stdout: '', stderr: '' });
      responses.set(`pactl set-sink-volume pipe_ai_to_voice_${NAMESPACE} 45875`, { stdout: '', stderr: '' });

      const pipeline = new AudioPipeline(NAMESPACE, mockExec, silentLogger);
      const devices: AudioDevices = await pipeline.setup();

      expect(devices.voiceSink).toBe(22);
      expect(devices.aiSink).toBe(23);
      expect(devices.voiceSource).toBe(24);
      expect(devices.aiSource).toBe(25);

      const loadCalls = calls.filter(c => c.startsWith('pactl load-module'));
      expect(loadCalls).toHaveLength(4);
    });

    it('calls ensurePulseAudio() first', async () => {
      const { mockExec, calls, responses } = createMockExec();
      responses.set('pactl info', { stdout: 'ok', stderr: '' });
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      let nextId = 1;
      responses.set(`pactl load-module module-null-sink sink_name=pipe_voice_to_ai_${NAMESPACE} format=float32le sink_properties="device.description='Voice_Out_to_AI_In_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-null-sink sink_name=pipe_ai_to_voice_${NAMESPACE} format=float32le sink_properties="device.description='AI_Out_to_Voice_In_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-remap-source master=pipe_voice_to_ai_${NAMESPACE}.monitor source_name=src_voice_to_ai_${NAMESPACE} source_properties="device.description='Voice_Audio_to_AI_Mic_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl load-module module-remap-source master=pipe_ai_to_voice_${NAMESPACE}.monitor source_name=src_ai_to_voice_${NAMESPACE} source_properties="device.description='AI_Audio_to_Voice_Mic_${NAMESPACE}'"`, { stdout: String(nextId++), stderr: '' });
      responses.set(`pactl set-sink-volume pipe_voice_to_ai_${NAMESPACE} 45875`, { stdout: '', stderr: '' });
      responses.set(`pactl set-sink-volume pipe_ai_to_voice_${NAMESPACE} 45875`, { stdout: '', stderr: '' });

      const pipeline = new AudioPipeline(NAMESPACE, mockExec, silentLogger);
      await pipeline.setup();

      const infoIdx = calls.indexOf('pactl info');
      const firstLoadIdx = calls.findIndex(c => c.startsWith('pactl load-module'));
      expect(infoIdx).toBeLessThan(firstLoadIdx);
    });

    it('rejects if any module fails to load', async () => {
      const { mockExec, responses, errors } = createMockExec();
      responses.set('pactl info', { stdout: 'ok', stderr: '' });
      responses.set('pactl list modules short', { stdout: '', stderr: '' });
      responses.set(`pactl load-module module-null-sink sink_name=pipe_voice_to_ai_${NAMESPACE} format=float32le sink_properties="device.description='Voice_Out_to_AI_In_${NAMESPACE}'"`, { stdout: '28', stderr: '' });
      errors.set(
        `pactl load-module module-null-sink sink_name=pipe_ai_to_voice_${NAMESPACE} format=float32le sink_properties="device.description='AI_Out_to_Voice_In_${NAMESPACE}'"`,
        new Error('Failure')
      );

      const pipeline = new AudioPipeline(NAMESPACE, mockExec, silentLogger);
      await expect(pipeline.setup()).rejects.toThrow();
    });
  });

  describe('teardown()', () => {
    it('unloads all 4 modules by ID', async () => {
      const { mockExec, calls } = createMockExec();

      const devices: AudioDevices = { voiceSink: 10, aiSink: 11, voiceSource: 12, aiSource: 13 };
      const pipeline = new AudioPipeline(NAMESPACE, mockExec, silentLogger);
      await pipeline.teardown(devices);

      expect(calls).toContain('pactl unload-module 10');
      expect(calls).toContain('pactl unload-module 11');
      expect(calls).toContain('pactl unload-module 12');
      expect(calls).toContain('pactl unload-module 13');
    });

    it('continues even if one module fails to unload', async () => {
      const { mockExec, calls, errors } = createMockExec();
      errors.set('pactl unload-module 11', new Error('No such module'));

      const devices: AudioDevices = { voiceSink: 10, aiSink: 11, voiceSource: 12, aiSource: 13 };
      const pipeline = new AudioPipeline(NAMESPACE, mockExec, silentLogger);

      await expect(pipeline.teardown(devices)).resolves.toBeUndefined();

      expect(calls).toContain('pactl unload-module 10');
      expect(calls).toContain('pactl unload-module 11');
      expect(calls).toContain('pactl unload-module 12');
      expect(calls).toContain('pactl unload-module 13');
    });
  });
});
