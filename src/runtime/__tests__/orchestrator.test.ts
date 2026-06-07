/**
 * BridgeOrchestrator Tests — provider-aware, multi-instance.
 */

import { BridgeOrchestrator } from '../orchestrator';
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
  } as unknown as jest.Mocked<AudioPipeline>;

  const mockVoicePage = { url: jest.fn().mockReturnValue('https://voice.google.com') };
  const mockAIPage = { url: jest.fn().mockReturnValue('https://grok.com') };
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
  } as unknown as jest.Mocked<BrowserManager>;

  const eventHandlers: Record<string, Function[]> = {
    incomingCall: [],
    callAccepted: [],
    callEnded: [],
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
});
