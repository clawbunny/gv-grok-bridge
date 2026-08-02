/**
 * BridgeOrchestrator Tests — provider-aware, multi-instance.
 */

import { BridgeOrchestrator, computeCriticalIssues } from '../orchestrator';
import { XvfbManager } from '../xvfb';
import { SilentLogger, type Logger } from '../../logger';
import { AudioPipeline } from '../audio/pipeline';
import { BrowserManager } from '../browser/manager';
import { VoiceMonitor } from '../monitor';
import { AIController } from '../ai-controller';
import type { BridgeConfig, BrowserPair, CallInfo, AudioDevices } from '../../types';
import type { VoiceProvider, AIProvider } from '../../providers/contracts';

function createMocks() {
  const logger: jest.Mocked<Logger> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const audioPipeline = {
    setup: jest.fn().mockResolvedValue({
      voiceSink: 1,
      aiSink: 2,
      voiceSource: 3,
      aiSource: 4,
    } as AudioDevices),
    teardown: jest.fn().mockResolvedValue(undefined),
    fixStreamRouting: jest.fn().mockResolvedValue(undefined),
    fixSinkRouting: jest.fn().mockResolvedValue(undefined),
    setDefaultSource: jest.fn().mockResolvedValue(undefined),
    setDefaultSink: jest.fn().mockResolvedValue(undefined),
    startEventRouter: jest.fn(),
    stopEventRouter: jest.fn(),
    sampleAudioLevel: jest.fn().mockResolvedValue(null),
    deviceNames: {
      voiceSink: 'pipe_voice_to_ai',
      aiSink: 'pipe_ai_to_voice',
      voiceSource: 'src_voice_to_ai',
      aiSource: 'src_ai_to_voice',
    },
  } as unknown as jest.Mocked<AudioPipeline>;

  const mockVoicePage = {
    url: jest.fn().mockReturnValue('https://voice.google.com'),
    evaluate: jest.fn().mockResolvedValue('Voice'),
    reload: jest.fn().mockResolvedValue(undefined),
  };
  const mockAIPage = {
    url: jest.fn().mockReturnValue('https://grok.com'),
    evaluate: jest.fn().mockResolvedValue('Grok'),
    reload: jest.fn().mockResolvedValue(undefined),
  };
  const mockVoiceCtx = { pages: jest.fn().mockReturnValue([mockVoicePage]) };
  const mockAICtx = { pages: jest.fn().mockReturnValue([mockAIPage]) };

  const fakePair = {
    voice: mockVoiceCtx,
    ai: mockAICtx,
    voicePage: mockVoicePage,
    aiPage: mockAIPage,
  } as unknown as BrowserPair;

  const browserManager = {
    launch: jest.fn().mockResolvedValue(fakePair),
    close: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
    getPair: jest.fn().mockReturnValue(fakePair),
    getCDPSession: jest.fn().mockResolvedValue(null),
    recyclePage: jest.fn().mockImplementation((role: 'voice' | 'ai') =>
      Promise.resolve(role === 'voice' ? mockVoicePage : mockAIPage)),
    getOpenWebSocketCount: jest.fn().mockReturnValue(1),
  } as unknown as jest.Mocked<BrowserManager>;

  const eventHandlers: Record<string, Function[]> = {
    incomingCall: [],
    callAccepted: [],
    callEnded: [],
    acceptFailed: [],
    pollTimeout: [],
    error: [],
  };

  const voiceMonitor = {
    startMonitoring: jest.fn().mockResolvedValue(undefined),
    stopMonitoring: jest.fn().mockResolvedValue(undefined),
    on: jest.fn().mockImplementation((event: string, handler: Function) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    isInCall: jest.fn().mockReturnValue(false),
    getCurrentCall: jest.fn().mockReturnValue(null),
    _handlers: eventHandlers,
    _emit(event: string, ...args: any[]) {
      const handlers = eventHandlers[event] || [];
      handlers.forEach((h) => h(...args));
    },
  } as any;

  const aiController = {
    initialize: jest.fn().mockResolvedValue(true),
    activateVoiceMode: jest.fn().mockResolvedValue(true),
    deactivateVoiceMode: jest.fn().mockResolvedValue(undefined),
    isVoiceModeActive: jest.fn().mockReturnValue(false),
  } as unknown as jest.Mocked<AIController>;

  const voiceProvider = {
    id: 'google-voice',
    name: 'Google Voice',
    url: 'https://voice.google.com',
    origin: 'https://voice.google.com',
    initialize: jest.fn().mockResolvedValue(true),
    checkLoggedIn: jest.fn().mockResolvedValue(true),
    detectIncomingCall: jest.fn().mockResolvedValue(null),
    acceptCall: jest.fn().mockResolvedValue(undefined),
    declineCall: jest.fn().mockResolvedValue(undefined),
    isCallActive: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<VoiceProvider>;

  const aiProvider = {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    origin: 'https://grok.com',
    initialize: jest.fn().mockResolvedValue(true),
    checkLoggedIn: jest.fn().mockResolvedValue(true),
    activateVoiceMode: jest.fn().mockResolvedValue(true),
    deactivateVoiceMode: jest.fn().mockResolvedValue(undefined),
    isVoiceModeActive: jest.fn().mockReturnValue(false),
    verifyVoiceSession: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<AIProvider>;

  const xvfbManager = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    isRunning: jest.fn().mockReturnValue(false),
  } as unknown as jest.Mocked<XvfbManager>;

  return {
    logger,
    audioPipeline,
    browserManager,
    voiceMonitor,
    aiController,
    voiceProvider,
    aiProvider,
    xvfbManager,
  };
}

const defaultConfig: BridgeConfig = {
  instanceId: 'test-instance',
  namespace: 'test_instance',
  defaultProfilePath: '/home/user/.config/chromium',
  tempProfilePath: '/tmp/test-chromium-profile',
  authorizedNumbers: ['+15551234567'],
  authorizedNames: ['Alice'],
  headless: true,
  displayNum: ':99',
  autoAccept: true,
  pollInterval: 1000,
  logLevel: 'debug',
  voiceProvider: { type: 'google-voice' },
  aiProvider: { type: 'grok' },
};

describe('BridgeOrchestrator', () => {
  let mocks: ReturnType<typeof createMocks>;
  let orchestrator: BridgeOrchestrator;

  beforeEach(() => {
    jest.useRealTimers();
    mocks = createMocks();
    orchestrator = new BridgeOrchestrator(
      defaultConfig,
      mocks.audioPipeline as any,
      mocks.browserManager as any,
      mocks.voiceMonitor as any,
      mocks.aiController as any,
      mocks.voiceProvider as any,
      mocks.aiProvider as any,
      mocks.xvfbManager as any,
      mocks.logger as any,
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    await orchestrator.stop();
    jest.clearAllMocks();
  });

  describe('start()', () => {
    it('starts all subsystems in sequence', async () => {
      await orchestrator.start();

      expect(mocks.audioPipeline.setup).toHaveBeenCalled();
      expect(mocks.xvfbManager.start).toHaveBeenCalledWith(':99');
      expect(mocks.browserManager.launch).toHaveBeenCalled();
      expect(mocks.voiceMonitor.startMonitoring).toHaveBeenCalled();
      expect(mocks.aiController.initialize).toHaveBeenCalled();
      expect(mocks.voiceMonitor.on).toHaveBeenCalled();
    });

    it('sets status.running = true on success', async () => {
      await orchestrator.start();
      expect(orchestrator.getStatus().running).toBe(true);
    });

    it('does not start xvfb when headless=false', async () => {
      const nonHeadlessConfig = { ...defaultConfig, headless: false };
      orchestrator = new BridgeOrchestrator(
        nonHeadlessConfig,
        mocks.audioPipeline as any,
        mocks.browserManager as any,
        mocks.voiceMonitor as any,
        mocks.aiController as any,
        mocks.voiceProvider as any,
        mocks.aiProvider as any,
        mocks.xvfbManager as any,
        mocks.logger as any,
      );

      await orchestrator.start();
      expect(mocks.xvfbManager.start).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('cleans up all resources', async () => {
      await orchestrator.start();
      jest.clearAllMocks();

      await orchestrator.stop();

      expect(mocks.voiceMonitor.stopMonitoring).toHaveBeenCalled();
      expect(mocks.browserManager.close).toHaveBeenCalled();
      expect(mocks.audioPipeline.teardown).toHaveBeenCalled();
      expect(mocks.xvfbManager.stop).toHaveBeenCalled();
    });
  });

  describe('event handlers', () => {
    beforeEach(async () => {
      await orchestrator.start();
    });

    it('activates AI voice mode on call accepted', async () => {
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };

      mocks.aiController.activateVoiceMode.mockResolvedValue(true);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(orchestrator.getStatus().inCall).toBe(true);
      expect(mocks.aiController.activateVoiceMode).toHaveBeenCalled();
    });

    it('deactivates AI voice mode on call ended', async () => {
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };
      mocks.aiController.activateVoiceMode.mockResolvedValue(true);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      mocks.voiceMonitor._emit('callEnded');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(orchestrator.getStatus().inCall).toBe(false);
      expect(mocks.aiController.deactivateVoiceMode).toHaveBeenCalled();
    });
  });

  describe('voice session verification', () => {
    const call: CallInfo = {
      phoneNumber: '+15551234567',
      callerName: 'Alice',
      timestamp: new Date(),
    };

    it('marks aiVoiceUnavailable and writes status when verification fails', async () => {
      const statusWriter = { write: jest.fn() };
      orchestrator = new BridgeOrchestrator(
        defaultConfig,
        mocks.audioPipeline as any,
        mocks.browserManager as any,
        mocks.voiceMonitor as any,
        mocks.aiController as any,
        mocks.voiceProvider as any,
        mocks.aiProvider as any,
        mocks.xvfbManager as any,
        mocks.logger as any,
        statusWriter as any,
      );
      await orchestrator.start();

      (mocks.aiProvider.verifyVoiceSession as jest.Mock).mockResolvedValue(false);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = orchestrator.getStatus();
      expect(status.aiVoiceUnavailable).toBe(true);
      expect(status.aiVoiceStatusDetail).toMatch(/credits/);
      expect(statusWriter.write).toHaveBeenCalled();
      const lastIssues = statusWriter.write.mock.calls.at(-1)![1] as string[];
      expect(lastIssues.some((i) => i.startsWith('ai_voice_unavailable'))).toBe(true);
    });

    it('clears aiVoiceUnavailable on a verified activation', async () => {
      await orchestrator.start();

      (mocks.aiProvider.verifyVoiceSession as jest.Mock).mockResolvedValueOnce(false);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(orchestrator.getStatus().aiVoiceUnavailable).toBe(true);

      mocks.voiceMonitor._emit('callEnded');
      await new Promise((resolve) => setTimeout(resolve, 10));

      (mocks.aiProvider.verifyVoiceSession as jest.Mock).mockResolvedValueOnce(true);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = orchestrator.getStatus();
      expect(status.aiVoiceUnavailable).toBe(false);
      expect(status.aiVoiceStatusDetail).toBeUndefined();
    });
  });

  describe('health tick self-healing', () => {
    let exitSpy: jest.SpyInstance;

    beforeEach(async () => {
      await orchestrator.start();
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('recycles the voice page after repeated probe failures instead of restarting', async () => {
      const pair = mocks.browserManager.getPair() as any;
      pair.voicePage.evaluate.mockRejectedValue(new Error('hung'));

      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();
      expect(mocks.browserManager.recyclePage).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      await (orchestrator as any).runHealthTick();
      expect(mocks.browserManager.recyclePage).toHaveBeenCalledWith('voice');
      expect(exitSpy).not.toHaveBeenCalled();
      // monitoring restarted on the fresh page
      expect(mocks.voiceMonitor.stopMonitoring).toHaveBeenCalled();
      expect(mocks.voiceMonitor.startMonitoring).toHaveBeenCalledTimes(2);
      expect(orchestrator.getStatus().voicePageResponsive).toBe(true);
      expect(orchestrator.getStatus().voicePageRecycles).toBe(1);
    });

    it('does not recycle the voice page while a call is active', async () => {
      const pair = mocks.browserManager.getPair() as any;
      pair.voicePage.evaluate.mockRejectedValue(new Error('hung'));

      mocks.voiceMonitor._emit('callAccepted', {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();
      expect(mocks.browserManager.recyclePage).not.toHaveBeenCalled();
      expect(orchestrator.getStatus().voicePageResponsive).toBe(false);
    });

    it('recycles the voice page when it has no open websockets while idle', async () => {
      (mocks.browserManager.getOpenWebSocketCount as jest.Mock).mockReturnValue(0);

      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();
      expect(mocks.browserManager.recyclePage).not.toHaveBeenCalled();

      await (orchestrator as any).runHealthTick();
      expect(mocks.browserManager.recyclePage).toHaveBeenCalledWith('voice');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('recycles the voice page after repeated idle poll timeouts', async () => {
      mocks.voiceMonitor._emit('pollTimeout', new Error('Poll cycle timed out'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mocks.browserManager.recyclePage).not.toHaveBeenCalled();

      mocks.voiceMonitor._emit('pollTimeout', new Error('Poll cycle timed out'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mocks.browserManager.recyclePage).toHaveBeenCalledWith('voice');
    });

    it('escalates to restart when post-recycle login check fails', async () => {
      const pair = mocks.browserManager.getPair() as any;
      pair.voicePage.evaluate.mockRejectedValue(new Error('hung'));
      mocks.voiceProvider.checkLoggedIn.mockResolvedValue(false);

      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();
      await (orchestrator as any).runHealthTick();

      expect(mocks.browserManager.recyclePage).toHaveBeenCalledWith('voice');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('escalates to restart when the recycle budget is exhausted', async () => {
      const pair = mocks.browserManager.getPair() as any;
      pair.voicePage.evaluate.mockRejectedValue(new Error('hung'));

      // Each batch of 3 probe failures triggers one recycle; after 3
      // recycles the budget is exhausted and the next one must escalate.
      for (let round = 0; round < 4 && !exitSpy.mock.calls.length; round++) {
        await (orchestrator as any).runHealthTick();
        await (orchestrator as any).runHealthTick();
        await (orchestrator as any).runHealthTick();
        // recycle succeeds → probe failures reset; page keeps hanging
        pair.voicePage.evaluate.mockRejectedValue(new Error('hung'));
      }

      expect(mocks.browserManager.recyclePage).toHaveBeenCalledTimes(3);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('defers restart while a call is active, then restarts on call end', async () => {
      (orchestrator as any).pendingRestart = 'test fatal condition';

      mocks.voiceMonitor._emit('callAccepted', {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await (orchestrator as any).runHealthTick();
      expect(exitSpy).not.toHaveBeenCalled();

      mocks.voiceMonitor._emit('callEnded');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('tracks state transitions through the call lifecycle', async () => {
      expect(orchestrator.getState()).toBe('IDLE');

      mocks.voiceMonitor._emit('incomingCall', {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(orchestrator.getState()).toBe('INCOMING_CALL');

      mocks.voiceMonitor._emit('callAccepted', {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(orchestrator.getState()).toBe('BRIDGED');

      mocks.voiceMonitor._emit('callEnded');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(orchestrator.getState()).toBe('IDLE');
    });

    it('writes a call record on acceptFailed', async () => {
      const metricsWriter = { append: jest.fn() };
      orchestrator = new BridgeOrchestrator(
        defaultConfig,
        mocks.audioPipeline as any,
        mocks.browserManager as any,
        mocks.voiceMonitor as any,
        mocks.aiController as any,
        mocks.voiceProvider as any,
        mocks.aiProvider as any,
        mocks.xvfbManager as any,
        mocks.logger as any,
        undefined,
        metricsWriter as any,
      );
      await orchestrator.start();

      const call = { phoneNumber: '+15551234567', callerName: 'Alice', timestamp: new Date() };
      mocks.voiceMonitor._emit('incomingCall', call);
      await new Promise((resolve) => setTimeout(resolve, 10));
      mocks.voiceMonitor._emit('acceptFailed', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(metricsWriter.append).toHaveBeenCalledTimes(1);
      const record = metricsWriter.append.mock.calls[0][0];
      expect(record.endReason).toBe('accept_failed');
      expect(record.phoneNumber).toBe('+15551234567');
    });
  });
});

describe('computeCriticalIssues', () => {
  const healthy = {
    running: true,
    audioReady: true,
    voiceBrowserReady: true,
    aiBrowserReady: true,
    voiceLoggedIn: true,
    aiLoggedIn: true,
    inCall: false,
    voiceModeActive: false,
    aiVoiceUnavailable: false,
    voicePageResponsive: true,
    aiPageResponsive: true,
  };

  it('returns no issues when healthy', () => {
    expect(computeCriticalIssues(healthy)).toEqual([]);
  });

  it('includes ai_voice_unavailable with detail', () => {
    const issues = computeCriticalIssues({
      ...healthy,
      aiVoiceUnavailable: true,
      aiVoiceStatusDetail: 'out of credits',
    });
    expect(issues).toEqual(['ai_voice_unavailable: out of credits']);
  });

  it('includes unresponsive page issues', () => {
    const issues = computeCriticalIssues({
      ...healthy,
      voicePageResponsive: false,
      aiPageResponsive: false,
    });
    expect(issues).toContain('voice_page_unresponsive');
    expect(issues).toContain('ai_page_unresponsive');
  });

  it('flags missing logins only when running', () => {
    expect(computeCriticalIssues({ ...healthy, voiceLoggedIn: false })).toContain('voice_not_logged_in');
    expect(computeCriticalIssues({ ...healthy, running: false, voiceLoggedIn: false })).toEqual([]);
  });
});
