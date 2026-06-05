/**
 * BridgeOrchestrator Tests — TDD first
 * Full dependency injection, all mocks via jest.fn()
 */

import { BridgeOrchestrator } from '../orchestrator';
import { XvfbManager } from '../xvfb';
import { SilentLogger, type Logger } from '../../logger';
import { AudioPipeline } from '../../audio/pipeline';
import { BrowserManager } from '../../browser/manager';
import { VoiceMonitor } from '../../voice/monitor';
import { GrokController } from '../../grok/controller';
import type { BridgeConfig, BrowserPair, CallInfo, AudioDevices } from '../../types';

// Build typed mocks for all dependencies
function createMocks() {
  const logger: jest.Mocked<Logger> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const audioPipeline = {
    setup: jest.fn().mockResolvedValue({
      gvSink: 1,
      grokSink: 2,
      gvSource: 3,
      grokSource: 4,
    } as AudioDevices),
    teardown: jest.fn().mockResolvedValue(undefined),
    fixStreamRouting: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AudioPipeline>;

  const mockGvPage = { url: jest.fn().mockReturnValue('https://voice.google.com') };
  const mockGrokPage = { url: jest.fn().mockReturnValue('https://grok.com') };
  const mockGvCtx = { pages: jest.fn().mockReturnValue([mockGvPage]) };
  const mockGrokCtx = { pages: jest.fn().mockReturnValue([mockGrokPage]) };

  const fakePair = {
    gv: mockGvCtx,
    grok: mockGrokCtx,
    gvPage: mockGvPage,
    grokPage: mockGrokPage,
  } as unknown as BrowserPair;

  const browserManager = {
    launch: jest.fn().mockResolvedValue(fakePair),
    close: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
    getPair: jest.fn().mockReturnValue(fakePair),
    getCDPSession: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<BrowserManager>;

  // Event handler storage — lets tests trigger events
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
    // Helpers for tests to emit events
    _handlers: eventHandlers,
    _emit(event: string, ...args: any[]) {
      const handlers = eventHandlers[event] || [];
      handlers.forEach((h) => h(...args));
    },
  } as any;

  const grokController = {
    initialize: jest.fn().mockResolvedValue(true),
    activateVoiceMode: jest.fn().mockResolvedValue(true),
    deactivateVoiceMode: jest.fn().mockResolvedValue(undefined),
    isVoiceModeActive: jest.fn().mockReturnValue(false),
  } as unknown as jest.Mocked<GrokController>;

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
    grokController,
    xvfbManager,
    mockGvPage,
    mockGrokPage,
  };
}

const defaultConfig: BridgeConfig = {
  defaultProfilePath: '/home/user/.config/chromium',
  tempProfilePath: '/tmp/grok-chromium-profile',
  authorizedNumbers: ['+15551234567'],
  authorizedNames: ['Alice'],
  headless: true,
  displayNum: ':99',
  autoAccept: true,
  pollInterval: 1000,
  logLevel: 'debug',
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
      mocks.grokController as any,
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
    it('calls setupAudio → xvfb.start → browserManager.launch → checkLogins → event wiring → health checks in sequence', async () => {
      const headlessConfig = { ...defaultConfig, headless: true };
      orchestrator = new BridgeOrchestrator(
        headlessConfig,
        mocks.audioPipeline as any,
        mocks.browserManager as any,
        mocks.voiceMonitor as any,
        mocks.grokController as any,
        mocks.xvfbManager as any,
        mocks.logger as any,
      );

      await orchestrator.start();

      // Verify sequence
      expect(mocks.audioPipeline.setup).toHaveBeenCalled();
      expect(mocks.xvfbManager.start).toHaveBeenCalledWith(':99');
      expect(mocks.browserManager.launch).toHaveBeenCalledWith(headlessConfig);
      expect(mocks.voiceMonitor.startMonitoring).toHaveBeenCalled();
      expect(mocks.grokController.initialize).toHaveBeenCalled();
      expect(mocks.voiceMonitor.on).toHaveBeenCalled();
    });

    it('sets status.running = true on success', async () => {
      await orchestrator.start();
      const status = orchestrator.getStatus();
      expect(status.running).toBe(true);
    });

    it('sets audioReady=true and browserReady flags on success', async () => {
      await orchestrator.start();
      const status = orchestrator.getStatus();
      expect(status.audioReady).toBe(true);
      expect(status.gvBrowserReady).toBe(true);
      expect(status.grokBrowserReady).toBe(true);
    });

    it('does not start xvfb when headless=false', async () => {
      const nonHeadlessConfig = { ...defaultConfig, headless: false };
      orchestrator = new BridgeOrchestrator(
        nonHeadlessConfig,
        mocks.audioPipeline as any,
        mocks.browserManager as any,
        mocks.voiceMonitor as any,
        mocks.grokController as any,
        mocks.xvfbManager as any,
        mocks.logger as any,
      );

      await orchestrator.start();
      expect(mocks.xvfbManager.start).not.toHaveBeenCalled();
    });

    it('throws and calls stop cleanup on failure', async () => {
      mocks.audioPipeline.setup.mockRejectedValueOnce(new Error('Audio setup failed'));

      // Spy on stop to verify cleanup is called
      const stopSpy = jest.spyOn(orchestrator, 'stop');

      await expect(orchestrator.start()).rejects.toThrow('Audio setup failed');
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('stops health checks → voiceMonitor → browsers → audio → xvfb in order', async () => {
      await orchestrator.start();
      jest.clearAllMocks();

      await orchestrator.stop();

      expect(mocks.voiceMonitor.stopMonitoring).toHaveBeenCalled();
      expect(mocks.browserManager.close).toHaveBeenCalled();
      expect(mocks.audioPipeline.teardown).toHaveBeenCalled();
      expect(mocks.xvfbManager.stop).toHaveBeenCalled();
    });

    it('sets all status flags to false', async () => {
      await orchestrator.start();
      await orchestrator.stop();

      const status = orchestrator.getStatus();
      expect(status.running).toBe(false);
      expect(status.audioReady).toBe(false);
      expect(status.gvBrowserReady).toBe(false);
      expect(status.grokBrowserReady).toBe(false);
      expect(status.gvLoggedIn).toBe(false);
      expect(status.grokLoggedIn).toBe(false);
      expect(status.inCall).toBe(false);
      expect(status.voiceModeActive).toBe(false);
    });

    it('is safe to call multiple times', async () => {
      await orchestrator.start();
      await orchestrator.stop();
      await orchestrator.stop(); // should not throw

      expect(mocks.browserManager.close).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus()', () => {
    it('returns a copy of current status (not a reference)', async () => {
      await orchestrator.start();
      const status1 = orchestrator.getStatus();
      const status2 = orchestrator.getStatus();
      expect(status1).toEqual(status2);
      expect(status1).not.toBe(status2); // different object reference
    });

    it('returns default status before start', () => {
      const status = orchestrator.getStatus();
      expect(status.running).toBe(false);
      expect(status.audioReady).toBe(false);
      expect(status.inCall).toBe(false);
    });
  });

  describe('event handlers', () => {
    beforeEach(async () => {
      await orchestrator.start();
    });

    it('onIncomingCall logs call info', async () => {
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };

      mocks.voiceMonitor._emit('incomingCall', call);

      // The handler is async with .catch(), give it a tick
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Incoming call'),
      );
    });

    it('onCallAccepted updates status inCall=true and activates Grok voice', async () => {
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };

      mocks.grokController.activateVoiceMode.mockResolvedValue(true);

      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = orchestrator.getStatus();
      expect(status.inCall).toBe(true);
      expect(status.currentCall).toEqual(call);
      expect(mocks.grokController.activateVoiceMode).toHaveBeenCalledWith(
        expect.anything(),
      );
    });

    it('calls fixStreamRouting after voice mode activation', async () => {
      jest.useFakeTimers();
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };

      mocks.grokController.activateVoiceMode.mockResolvedValue(true);

      mocks.voiceMonitor._emit('callAccepted', call);
      await Promise.resolve(); // flush microtasks

      expect(mocks.audioPipeline.fixStreamRouting).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mocks.audioPipeline.fixStreamRouting).toHaveBeenCalledWith(
        defaultConfig.defaultProfilePath,
        defaultConfig.tempProfilePath,
      );

      jest.advanceTimersByTime(6000);
      await Promise.resolve();

      expect(mocks.audioPipeline.fixStreamRouting).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('unrefs setTimeout timers so they do not keep process alive', async () => {
      const unrefMock = jest.fn();
      const originalSetTimeout = global.setTimeout;

      global.setTimeout = jest.fn((callback: any, delay: number, ...args: any[]) => {
        const timer = originalSetTimeout(callback, delay, ...args);
        return { ...timer, unref: unrefMock };
      }) as any;

      try {
        const call: CallInfo = {
          phoneNumber: '+15551234567',
          callerName: 'Alice',
          timestamp: new Date(),
        };

        mocks.grokController.activateVoiceMode.mockResolvedValue(true);
        mocks.voiceMonitor._emit('callAccepted', call);
        await new Promise((resolve) => originalSetTimeout(resolve, 10));

        expect(unrefMock).toHaveBeenCalledTimes(2);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('onCallEnded updates status inCall=false and deactivates Grok voice', async () => {
      // First accept a call
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };
      mocks.grokController.activateVoiceMode.mockResolvedValue(true);
      mocks.voiceMonitor._emit('callAccepted', call);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(orchestrator.getStatus().inCall).toBe(true);

      // Now end it
      mocks.voiceMonitor._emit('callEnded');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = orchestrator.getStatus();
      expect(status.inCall).toBe(false);
      expect(status.currentCall).toBeUndefined();
      expect(mocks.grokController.deactivateVoiceMode).toHaveBeenCalled();
    });
  });

  describe('health checks', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      await orchestrator.start();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('periodically checks browser health', async () => {
      mocks.browserManager.healthCheck.mockClear();
      jest.advanceTimersByTime(10000);
      await Promise.resolve(); // flush microtasks

      expect(mocks.browserManager.healthCheck).toHaveBeenCalled();
    });

    it('on health check failure updates browser status to not ready', async () => {
      mocks.browserManager.healthCheck.mockResolvedValue(false);

      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve(); // extra flush for async health check

      const status = orchestrator.getStatus();
      expect(status.gvBrowserReady).toBe(false);
      expect(status.grokBrowserReady).toBe(false);
    });

    it('calls fixStreamRouting during health checks when in a call', async () => {
      // Put orchestrator in-call
      const call: CallInfo = {
        phoneNumber: '+15551234567',
        callerName: 'Alice',
        timestamp: new Date(),
      };
      mocks.grokController.activateVoiceMode.mockResolvedValue(true);
      mocks.voiceMonitor._emit('callAccepted', call);
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.audioPipeline.fixStreamRouting).toHaveBeenCalledWith(
        defaultConfig.defaultProfilePath,
        defaultConfig.tempProfilePath,
      );
    });
  });
});
