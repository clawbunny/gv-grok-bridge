/**
 * Google Voice Provider Tests — strict TDD.
 */

import type { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import { GoogleVoiceProvider } from '../provider';
import { SilentLogger, type Logger } from '../../../../logger';

describe('GoogleVoiceProvider', () => {
  let provider: GoogleVoiceProvider;
  let logger: Logger;
  let mockPage: jest.Mocked<Page>;
  let mockContext: jest.Mocked<BrowserContext>;

  beforeEach(() => {
    logger = new SilentLogger();
    provider = new GoogleVoiceProvider();

    mockContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      addCookies: jest.fn().mockResolvedValue(undefined),
      cookies: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BrowserContext>;

    mockPage = {
      context: jest.fn().mockReturnValue(mockContext),
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://voice.google.com'),
      locator: jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({ click: jest.fn().mockResolvedValue(undefined) }),
      }),
      evaluate: jest.fn().mockResolvedValue(null),
      waitForSelector: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Page>;
  });

  describe('provider metadata', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('google-voice');
    });

    it('has correct name', () => {
      expect(provider.name).toBe('Google Voice');
    });

    it('has correct url', () => {
      expect(provider.url).toBe('https://voice.google.com');
    });

    it('has correct origin', () => {
      expect(provider.origin).toBe('https://voice.google.com');
    });
  });

  describe('initialize()', () => {
    it('grants microphone permissions', async () => {
      await provider.initialize(mockPage, logger);
      expect(mockContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://voice.google.com',
      });
    });

    it('returns true when logged in', async () => {
      mockPage.url.mockReturnValue('https://voice.google.com/u/0');
      const result = await provider.initialize(mockPage, logger);
      expect(result).toBe(true);
    });

    it('returns false when on login page', async () => {
      mockPage.url.mockReturnValue('https://accounts.google.com/ServiceLogin?continue=https://voice.google.com');
      const result = await provider.initialize(mockPage, logger);
      expect(result).toBe(false);
    });

    it('loads cookies from file when cookiePath is configured', async () => {
      const tmpFile = '/tmp/voicebridge-test-gv-cookies.json';
      fs.writeFileSync(tmpFile, JSON.stringify({ cookies: [] }));
      const providerWithCookies = new GoogleVoiceProvider(tmpFile);
      await providerWithCookies.initialize(mockPage, logger);
      expect(mockContext.addCookies).toHaveBeenCalled();
      fs.unlinkSync(tmpFile);
    });

    it('continues initialization when cookie file does not exist', async () => {
      const providerWithMissingCookies = new GoogleVoiceProvider('/tmp/nonexistent-cookies.json');
      mockPage.url.mockReturnValue('https://voice.google.com/u/0');
      const result = await providerWithMissingCookies.initialize(mockPage, logger);
      expect(result).toBe(true);
      expect(mockContext.addCookies).not.toHaveBeenCalled();
    });
  });

  describe('checkLoggedIn()', () => {
    it('returns true when URL is voice.google.com', async () => {
      mockPage.url.mockReturnValue('https://voice.google.com/u/0');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(true);
    });

    it('returns false when URL contains accounts.google.com', async () => {
      mockPage.url.mockReturnValue('https://accounts.google.com/ServiceLogin');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(false);
    });

    it('returns false when URL is workspace marketing page', async () => {
      mockPage.url.mockReturnValue('https://workspace.google.com/products/voice/');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(false);
    });
  });

  describe('acceptCall()', () => {
    it('clicks primary answer button', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(1),
          click: clickMock,
        }),
      } as any);

      await provider.acceptCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });

    it('warns when no answer button found', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({ click: jest.fn() }),
      } as any);

      await provider.acceptCall(mockPage, logger);
      // Should not throw; just warn
    });
  });

  describe('declineCall()', () => {
    it('clicks primary decline button', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(1),
          click: clickMock,
        }),
      } as any);

      await provider.declineCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });
  });

  describe('isCallActive()', () => {
    it('returns true when active call elements are present', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
      } as any);

      const result = await provider.isCallActive(mockPage, logger);
      expect(result).toBe(true);
    });

    it('returns false when no call elements are present', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
      } as any);

      const result = await provider.isCallActive(mockPage, logger);
      expect(result).toBe(false);
    });
  });
});
