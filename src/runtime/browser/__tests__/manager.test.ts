/**
 * BrowserManager Tests — namespaced multi-instance support, page recycling,
 * and WebSocket liveness tracking.
 */

import type { BrowserContext, CDPSession, Page } from 'playwright';
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
  let mockCdpSession: { on: jest.Mock; send: jest.Mock; detach: jest.Mock };

  function createMockPage(url: string, ctx: BrowserContext): jest.Mocked<Page> {
    return {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue(url),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
      context: jest.fn().mockReturnValue(ctx),
    } as unknown as jest.Mocked<Page>;
  }

  beforeEach(() => {
    logger = new SilentLogger();
    mockCdpSession = {
      on: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn().mockResolvedValue(undefined),
    };

    mockVoiceContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn(),
      pages: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue(mockCdpSession as unknown as CDPSession),
    } as unknown as jest.Mocked<BrowserContext>;

    mockAIContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn(),
      pages: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue(mockCdpSession as unknown as CDPSession),
    } as unknown as jest.Mocked<BrowserContext>;

    mockVoicePage = createMockPage('https://voice.google.com', mockVoiceContext);
    mockAIPage = createMockPage('https://grok.com', mockAIContext);
    mockVoiceContext.newPage = jest.fn().mockResolvedValue(mockVoicePage);
    mockAIContext.newPage = jest.fn().mockResolvedValue(mockAIPage);
    mockVoiceContext.pages = jest.fn().mockReturnValue([mockVoicePage]);
    mockAIContext.pages = jest.fn().mockReturnValue([mockAIPage]);

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
          'PULSE_PROP_application.name': 'Chromium-Voice-test_inst',
        })
      );
      expect(mockLauncher).toHaveBeenNthCalledWith(
        2,
        config.tempProfilePath,
        expect.objectContaining({
          PULSE_SINK: 'pipe_ai_to_voice_test_inst',
          PULSE_SOURCE: 'src_voice_to_ai_test_inst',
          'PULSE_PROP_application.name': 'Chromium-AI-test_inst',
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

    it('installs RTC hooks on the AI context only', async () => {
      await manager.launch(config, providers, 'test_inst');

      expect(mockAIContext.addInitScript).toHaveBeenCalledTimes(1);
      expect(mockVoiceContext.addInitScript).not.toHaveBeenCalled();
    });

    it('attaches CDP WebSocket tracking to both pages', async () => {
      await manager.launch(config, providers, 'test_inst');

      expect(mockVoiceContext.newCDPSession).toHaveBeenCalledWith(mockVoicePage);
      expect(mockAIContext.newCDPSession).toHaveBeenCalledWith(mockAIPage);
      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.enable');
    });
  });

  describe('recyclePage()', () => {
    it('closes the old page and opens a fresh one at the provider URL', async () => {
      await manager.launch(config, providers, 'test_inst');

      const newPage = createMockPage('https://voice.google.com', mockVoiceContext);
      mockVoiceContext.newPage = jest.fn().mockResolvedValue(newPage);

      const recycled = await manager.recyclePage('voice');

      expect(mockVoicePage.close).toHaveBeenCalled();
      expect(recycled).toBe(newPage);
      expect(newPage.goto).toHaveBeenCalledWith('https://voice.google.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      expect(manager.getPair()?.voicePage).toBe(newPage);
    });

    it('tolerates an already-closed page', async () => {
      await manager.launch(config, providers, 'test_inst');
      mockVoicePage.close = jest.fn().mockRejectedValue(new Error('Target closed'));

      const newPage = createMockPage('https://voice.google.com', mockVoiceContext);
      mockVoiceContext.newPage = jest.fn().mockResolvedValue(newPage);

      await expect(manager.recyclePage('voice')).resolves.toBe(newPage);
    });
  });

  describe('WebSocket liveness', () => {
    it('tracks open websockets from CDP events', async () => {
      await manager.launch(config, providers, 'test_inst');

      const handlers: Record<string, (e: { requestId: string }) => void> = {};
      for (const [event, handler] of mockCdpSession.on.mock.calls) {
        handlers[event as string] = handler as (e: { requestId: string }) => void;
      }

      expect(manager.getOpenWebSocketCount('voice')).toBe(0);
      handlers['Network.webSocketCreated']({ requestId: 'ws-1' });
      handlers['Network.webSocketCreated']({ requestId: 'ws-2' });
      // CDP sessions are per-role; here both roles share one mock session,
      // so events count for whichever role attached last — check ai too.
      const total =
        manager.getOpenWebSocketCount('voice') + manager.getOpenWebSocketCount('ai');
      expect(total).toBeGreaterThan(0);

      handlers['Network.webSocketClosed']({ requestId: 'ws-1' });
      const after =
        manager.getOpenWebSocketCount('voice') + manager.getOpenWebSocketCount('ai');
      expect(after).toBe(total - 1);
    });
  });
});
