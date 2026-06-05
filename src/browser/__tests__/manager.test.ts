/**
 * BrowserManager Tests — TDD first
 * Covers: launch, close, healthCheck, getPair with injected launcher
 */

import type { BrowserContext, Page } from 'playwright';
import { BrowserManager } from '../manager';
import { SilentLogger, type Logger } from '../../logger';

describe('BrowserManager', () => {
  let manager: BrowserManager;
  let mockLauncher: jest.Mock;
  let logger: Logger;
  let mockGvContext: jest.Mocked<BrowserContext>;
  let mockGrokContext: jest.Mocked<BrowserContext>;
  let mockGvPage: jest.Mocked<Page>;
  let mockGrokPage: jest.Mocked<Page>;

  beforeEach(() => {
    logger = new SilentLogger();
    mockGvPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://voice.google.com'),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Page>;

    mockGrokPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://grok.com'),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Page>;

    mockGvContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(mockGvPage),
      pages: jest.fn().mockReturnValue([mockGvPage]),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue({} as any),
    } as unknown as jest.Mocked<BrowserContext>;

    mockGrokContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(mockGrokPage),
      pages: jest.fn().mockReturnValue([mockGrokPage]),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue({} as any),
    } as unknown as jest.Mocked<BrowserContext>;

    mockLauncher = jest.fn();
    // First call returns gv context, second returns grok context
    mockLauncher
      .mockResolvedValueOnce(mockGvContext)
      .mockResolvedValueOnce(mockGrokContext);

    manager = new BrowserManager(mockLauncher, logger);
  });

  describe('getPair()', () => {
    it('returns null before launch', () => {
      expect(manager.getPair()).toBeNull();
    });
  });

  describe('launch()', () => {
    const config = {
      defaultProfilePath: '/home/user/.config/chromium',
      tempProfilePath: '/tmp/grok-chromium-profile',
      headless: true,
      displayNum: ':99',
    };

    it('copies profile and calls launcher twice with correct env vars', async () => {
      const result = await manager.launch(config);

      expect(mockLauncher).toHaveBeenCalledTimes(2);

      // First call: GV browser
      expect(mockLauncher).toHaveBeenNthCalledWith(
        1,
        config.defaultProfilePath,
        expect.objectContaining({
          PULSE_SINK: 'pipe_gv_to_grok',
          PULSE_SOURCE: 'src_grok_to_gv',
          DISPLAY: ':99',
        })
      );

      // Second call: Grok browser
      expect(mockLauncher).toHaveBeenNthCalledWith(
        2,
        config.tempProfilePath,
        expect.objectContaining({
          PULSE_SINK: 'pipe_grok_to_gv',
          PULSE_SOURCE: 'src_gv_to_grok',
          DISPLAY: ':99',
        })
      );
    });

    it('grants mic permissions for both origins', async () => {
      await manager.launch(config);

      expect(mockGvContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://voice.google.com',
      });
      expect(mockGrokContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://grok.com',
      });
    });

    it('navigates to correct URLs', async () => {
      await manager.launch(config);

      expect(mockGvPage.goto).toHaveBeenCalledWith('https://voice.google.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      expect(mockGrokPage.goto).toHaveBeenCalledWith('https://grok.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    });

    it('returns browser pair with contexts and pages', async () => {
      const result = await manager.launch(config);

      expect(result.gv).toBe(mockGvContext);
      expect(result.grok).toBe(mockGrokContext);
      expect(result.gvPage).toBe(mockGvPage);
      expect(result.grokPage).toBe(mockGrokPage);
    });

    it('cleans up launched contexts on failure and throws', async () => {
      // Make grok launch fail
      const error = new Error('Grok launch failed');
      mockLauncher
        .mockReset()
        .mockResolvedValueOnce(mockGvContext)
        .mockRejectedValueOnce(error);

      await expect(manager.launch(config)).rejects.toThrow('BrowserManager launch failed');

      // GV context should be closed during cleanup
      expect(mockGvContext.close).toHaveBeenCalled();
    });

    it('uses DISPLAY from env when headless=false', async () => {
      const originalDisplay = process.env.DISPLAY;
      process.env.DISPLAY = ':1';

      try {
        const nonHeadlessConfig = { ...config, headless: false };
        await manager.launch(nonHeadlessConfig);

        expect(mockLauncher).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.objectContaining({
            DISPLAY: ':1',
          })
        );
      } finally {
        process.env.DISPLAY = originalDisplay;
      }
    });

    it('sets unique PULSE_PROP_application.name for each browser', async () => {
      await manager.launch(config);

      expect(mockLauncher).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({
          PULSE_PROP_application_name: 'Chromium-GV',
        })
      );

      expect(mockLauncher).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({
          PULSE_PROP_application_name: 'Chromium-Grok',
        })
      );
    });

    it('kills lingering Chromium processes before launching browsers', async () => {
      const killSpy = jest.spyOn(manager as any, 'killLingeringProcesses').mockResolvedValue(undefined);
      await manager.launch(config);
      expect(killSpy).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('closes both contexts and clears pair', async () => {
      const config = {
        defaultProfilePath: '/home/user/.config/chromium',
        tempProfilePath: '/tmp/grok-chromium-profile',
        headless: false,
      };
      await manager.launch(config);
      expect(manager.getPair()).not.toBeNull();

      await manager.close();

      expect(mockGvContext.close).toHaveBeenCalled();
      expect(mockGrokContext.close).toHaveBeenCalled();
      expect(manager.getPair()).toBeNull();
    });

    it('does nothing when no pair is active', async () => {
      // Fresh manager, no launch
      const freshManager = new BrowserManager(mockLauncher, logger);
      await freshManager.close();

      expect(mockLauncher).not.toHaveBeenCalled();
    });
  });

  describe('healthCheck()', () => {
    const config = {
      defaultProfilePath: '/home/user/.config/chromium',
      tempProfilePath: '/tmp/grok-chromium-profile',
      headless: false,
    };

    it('returns false when no pair is launched', async () => {
      const result = await manager.healthCheck();
      expect(result).toBe(false);
    });

    it('returns true when both contexts respond', async () => {
      await manager.launch(config);
      const result = await manager.healthCheck();
      expect(result).toBe(true);
    });

    it('returns false when a context is dead', async () => {
      await manager.launch(config);

      // Make grok context throw on pages()
      mockGrokContext.pages.mockImplementation(() => {
        throw new Error('Context closed');
      });

      const result = await manager.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('getCDPSession()', () => {
    const config = {
      defaultProfilePath: '/home/user/.config/chromium',
      tempProfilePath: '/tmp/grok-chromium-profile',
      headless: false,
    };

    it('returns null when no pair is active', async () => {
      const result = await manager.getCDPSession('gv');
      expect(result).toBeNull();
    });

    it('creates CDP session for gv instance', async () => {
      await manager.launch(config);
      await manager.getCDPSession('gv');
      expect(mockGvContext.newCDPSession).toHaveBeenCalledWith(mockGvPage);
    });

    it('creates CDP session for grok instance', async () => {
      await manager.launch(config);
      await manager.getCDPSession('grok');
      expect(mockGrokContext.newCDPSession).toHaveBeenCalledWith(mockGrokPage);
    });
  });
});
