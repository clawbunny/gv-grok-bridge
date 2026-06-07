/**
 * BrowserManager Tests — namespaced multi-instance support.
 */

import type { BrowserContext, Page } from 'playwright';
import { BrowserManager } from '../manager';
import { SilentLogger, type Logger } from '../../../logger';

describe('BrowserManager', () => {
  let manager: BrowserManager;
  let mockLauncher: jest.Mock;
  let logger: Logger;
  let mockVoiceContext: jest.Mocked<BrowserContext>;
  let mockAIContext: jest.Mocked<BrowserContext>;
  let mockVoicePage: jest.Mocked<Page>;
  let mockAIPage: jest.Mocked<Page>;

  beforeEach(() => {
    logger = new SilentLogger();
    mockVoicePage = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://voice.google.com'),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Page>;

    mockAIPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://grok.com'),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Page>;

    mockVoiceContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(mockVoicePage),
      pages: jest.fn().mockReturnValue([mockVoicePage]),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue({} as any),
    } as unknown as jest.Mocked<BrowserContext>;

    mockAIContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(mockAIPage),
      pages: jest.fn().mockReturnValue([mockAIPage]),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue({} as any),
    } as unknown as jest.Mocked<BrowserContext>;

    mockLauncher = jest.fn();
    mockLauncher
      .mockResolvedValueOnce(mockVoiceContext)
      .mockResolvedValueOnce(mockAIContext);

    manager = new BrowserManager(mockLauncher, logger);
  });

  const config = {
    defaultProfilePath: '/home/user/.config/chromium',
    tempProfilePath: '/tmp/test-chromium-profile',
    headless: true,
    displayNum: ':99',
  };

  const providers = {
    voiceUrl: 'https://voice.google.com',
    aiUrl: 'https://grok.com',
    voiceOrigin: 'https://voice.google.com',
    aiOrigin: 'https://grok.com',
  };

  describe('launch()', () => {
    it('launches with namespaced PulseAudio env vars', async () => {
      await manager.launch(config, providers, 'test_inst');

      expect(mockLauncher).toHaveBeenCalledTimes(2);
      expect(mockLauncher).toHaveBeenNthCalledWith(
        1,
        config.defaultProfilePath,
        expect.objectContaining({
          PULSE_SINK: 'pipe_voice_to_ai_test_inst',
          PULSE_SOURCE: 'src_ai_to_voice_test_inst',
          PULSE_PROP_application_name: 'Chromium-Voice-test_inst',
        })
      );
      expect(mockLauncher).toHaveBeenNthCalledWith(
        2,
        config.tempProfilePath,
        expect.objectContaining({
          PULSE_SINK: 'pipe_ai_to_voice_test_inst',
          PULSE_SOURCE: 'src_voice_to_ai_test_inst',
          PULSE_PROP_application_name: 'Chromium-AI-test_inst',
        })
      );
    });

    it('grants mic permissions for provider origins', async () => {
      await manager.launch(config, providers, 'test_inst');

      expect(mockVoiceContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://voice.google.com',
      });
      expect(mockAIContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://grok.com',
      });
    });

    it('navigates to provider URLs', async () => {
      await manager.launch(config, providers, 'test_inst');

      expect(mockVoicePage.goto).toHaveBeenCalledWith('https://voice.google.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      expect(mockAIPage.goto).toHaveBeenCalledWith('https://grok.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    });
  });
});
