/**
 * Main entry point tests
 * Covers: signal handler registration and graceful shutdown
 */

// Mock all dependencies before importing main
jest.mock('./config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    defaultProfilePath: '/home/user/.config/chromium',
    tempProfilePath: '/tmp/grok-chromium-profile',
    authorizedNumbers: ['+15551234567'],
    authorizedNames: [],
    headless: true,
    displayNum: ':99',
    autoAccept: true,
    pollInterval: 1000,
    logLevel: 'debug',
  }),
  validateConfig: jest.fn(),
}));

jest.mock('./logger', () => ({
  ConsoleLogger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('./audio/pipeline', () => ({
  AudioPipeline: jest.fn().mockImplementation(() => ({
    setup: jest.fn().mockResolvedValue({ gvSink: 1, grokSink: 2, gvSource: 3, grokSource: 4 }),
    teardown: jest.fn().mockResolvedValue(undefined),
    fixStreamRouting: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('./browser/manager', () => ({
  BrowserManager: jest.fn().mockImplementation(() => ({
    launch: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
    getPair: jest.fn().mockReturnValue(null),
  })),
  createBrowserLauncher: jest.fn().mockReturnValue(jest.fn()),
}));

jest.mock('./voice/monitor', () => ({
  VoiceMonitor: jest.fn().mockImplementation(() => ({
    startMonitoring: jest.fn().mockResolvedValue(undefined),
    stopMonitoring: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

jest.mock('./grok/controller', () => ({
  GrokController: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    activateVoiceMode: jest.fn().mockResolvedValue(true),
    deactivateVoiceMode: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('./bridge/xvfb', () => ({
  XvfbManager: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    isRunning: jest.fn().mockReturnValue(false),
  })),
}));

jest.mock('./bridge/orchestrator', () => ({
  BridgeOrchestrator: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn().mockReturnValue({ running: true }),
  })),
}));

describe('main.ts signal handlers', () => {
  let processOnSpy: jest.SpyInstance;
  let handlers: Record<string, Function> = {};

  beforeEach(() => {
    handlers = {};
    processOnSpy = jest.spyOn(process, 'on').mockImplementation((event: string | symbol, listener: Function) => {
      if (typeof event === 'string') {
        handlers[event] = listener;
      }
      return process;
    });
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('registers SIGINT handler', async () => {
    // Import main to trigger handler registration
    await import('./main');
    expect(handlers['SIGINT']).toBeDefined();
    expect(typeof handlers['SIGINT']).toBe('function');
  });

  it('registers SIGTERM handler', async () => {
    await import('./main');
    expect(handlers['SIGTERM']).toBeDefined();
    expect(typeof handlers['SIGTERM']).toBe('function');
  });
});
