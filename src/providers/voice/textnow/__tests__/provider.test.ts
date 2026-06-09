/**
 * TextNow Voice Provider Tests — strict TDD.
 */

import type { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import { TextNowVoiceProvider } from '../provider';
import { SilentLogger, type Logger } from '../../../../logger';

describe('TextNowVoiceProvider', () => {
  let provider: TextNowVoiceProvider;
  let logger: Logger;
  let mockPage: jest.Mocked<Page>;
  let mockContext: jest.Mocked<BrowserContext>;

  beforeEach(() => {
    logger = new SilentLogger();
    provider = new TextNowVoiceProvider();

    mockContext = {
      grantPermissions: jest.fn().mockResolvedValue(undefined),
      addCookies: jest.fn().mockResolvedValue(undefined),
      cookies: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BrowserContext>;

    mockPage = {
      context: jest.fn().mockReturnValue(mockContext),
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://www.textnow.com/messaging'),
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
      expect(provider.id).toBe('textnow');
    });

    it('has correct name', () => {
      expect(provider.name).toBe('TextNow');
    });

    it('has correct url', () => {
      expect(provider.url).toBe('https://www.textnow.com/messaging');
    });

    it('has correct origin', () => {
      expect(provider.origin).toBe('https://www.textnow.com');
    });
  });

  describe('initialize()', () => {
    it('grants microphone permissions', async () => {
      await provider.initialize(mockPage, logger);
      expect(mockContext.grantPermissions).toHaveBeenCalledWith(['microphone'], {
        origin: 'https://www.textnow.com',
      });
    });

    it('navigates to messaging URL', async () => {
      await provider.initialize(mockPage, logger);
      expect(mockPage.goto).toHaveBeenCalledWith('https://www.textnow.com/messaging', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    });

    it('loads cookies from file when cookiePath is configured', async () => {
      const tmpFile = '/tmp/voicebridge-test-cookies.json';
      fs.writeFileSync(tmpFile, JSON.stringify({ cookies: [] }));
      const providerWithCookies = new TextNowVoiceProvider(tmpFile);
      await providerWithCookies.initialize(mockPage, logger);
      expect(mockContext.addCookies).toHaveBeenCalled();
      fs.unlinkSync(tmpFile);
    });

    it('returns true when logged in', async () => {
      mockPage.url.mockReturnValue('https://www.textnow.com/messaging');
      const result = await provider.initialize(mockPage, logger);
      expect(result).toBe(true);
    });

    it('returns false when on login page', async () => {
      mockPage.url.mockReturnValue('https://www.textnow.com/login');
      const result = await provider.initialize(mockPage, logger);
      expect(result).toBe(false);
    });
  });

  describe('checkLoggedIn()', () => {
    it('returns true when URL is messaging page', async () => {
      mockPage.url.mockReturnValue('https://www.textnow.com/messaging');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(true);
    });

    it('returns false when URL contains login', async () => {
      mockPage.url.mockReturnValue('https://www.textnow.com/login');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(false);
    });

    it('returns false when URL contains signin', async () => {
      mockPage.url.mockReturnValue('https://www.textnow.com/signin');
      const result = await provider.checkLoggedIn(mockPage, logger);
      expect(result).toBe(false);
    });
  });

  describe('detectIncomingCall()', () => {
    it('returns null when no incoming call UI is visible', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({ click: jest.fn().mockResolvedValue(undefined) }),
      } as any);

      const result = await provider.detectIncomingCall(mockPage, logger);
      expect(result).toBeNull();
    });

    it('detects incoming call from active-call wrapper', async () => {
      mockPage.locator.mockImplementation((selector: string) => {
        if (selector.includes('active-call') || selector.includes('incoming')) {
          return {
            count: jest.fn().mockResolvedValue(1),
            first: jest.fn().mockReturnValue({ click: jest.fn().mockResolvedValue(undefined) }),
          } as any;
        }
        return {
          count: jest.fn().mockResolvedValue(0),
          first: jest.fn().mockReturnValue({ click: jest.fn().mockResolvedValue(undefined) }),
        } as any;
      });

      mockPage.evaluate.mockResolvedValue({ rawNumber: '+1 (212) 555-1234', callerName: 'Test Caller', source: 'active-call' });

      const result = await provider.detectIncomingCall(mockPage, logger);
      expect(result).not.toBeNull();
      expect(result?.phoneNumber).toBe('+12125551234');
      expect(result?.callerName).toBe('Test Caller');
    });

    it('detects incoming call from popup with Incoming call text', async () => {
      mockPage.locator.mockImplementation((selector: string) => {
        if (selector.includes('active-call')) {
          return { count: jest.fn().mockResolvedValue(0) } as any;
        }
        return { count: jest.fn().mockResolvedValue(1) } as any;
      });

      mockPage.evaluate.mockResolvedValue({ rawNumber: '212-555-1234', callerName: '', source: 'popup' });

      const result = await provider.detectIncomingCall(mockPage, logger);
      expect(result).not.toBeNull();
      expect(result?.phoneNumber).toBe('+12125551234');
    });

    it('returns null when evaluate returns null', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
      } as any);
      mockPage.evaluate.mockResolvedValue(null);

      const result = await provider.detectIncomingCall(mockPage, logger);
      expect(result).toBeNull();
    });
  });

  describe('acceptCall()', () => {
    it('clicks primary answer button', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      mockPage.locator.mockImplementation((selector: string) => {
        if (selector.includes('Answer') || selector.includes('answer')) {
          return {
            count: jest.fn().mockResolvedValue(1),
            first: jest.fn().mockReturnValue({
              click: clickMock,
              count: jest.fn().mockResolvedValue(1),
            }),
          } as any;
        }
        return { count: jest.fn().mockResolvedValue(0) } as any;
      });

      await provider.acceptCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });

    it('falls back to generic answer selectors', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      let callCount = 0;
      mockPage.locator.mockImplementation((selector: string) => {
        callCount++;
        if (callCount >= 3) {
          return {
            count: jest.fn().mockResolvedValue(1),
            first: jest.fn().mockReturnValue({
              click: clickMock,
              count: jest.fn().mockResolvedValue(1),
            }),
          } as any;
        }
        return { count: jest.fn().mockResolvedValue(0) } as any;
      });

      await provider.acceptCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });

    it('warns when no answer button found', async () => {
      mockPage.locator.mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
      } as any);

      await provider.acceptCall(mockPage, logger);
      // Should not throw
    });
  });

  describe('declineCall()', () => {
    it('clicks primary decline button', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      mockPage.locator.mockImplementation((selector: string) => {
        if (selector.includes('Decline') || selector.includes('decline') || selector.includes('End') || selector.includes('end')) {
          return {
            count: jest.fn().mockResolvedValue(1),
            first: jest.fn().mockReturnValue({
              click: clickMock,
              count: jest.fn().mockResolvedValue(1),
            }),
          } as any;
        }
        return { count: jest.fn().mockResolvedValue(0) } as any;
      });

      await provider.declineCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });

    it('falls back to generic decline selectors', async () => {
      const clickMock = jest.fn().mockResolvedValue(undefined);
      let callCount = 0;
      mockPage.locator.mockImplementation((selector: string) => {
        callCount++;
        if (callCount >= 4) {
          return {
            count: jest.fn().mockResolvedValue(1),
            first: jest.fn().mockReturnValue({
              click: clickMock,
              count: jest.fn().mockResolvedValue(1),
            }),
          } as any;
        }
        return { count: jest.fn().mockResolvedValue(0) } as any;
      });

      await provider.declineCall(mockPage, logger);
      expect(clickMock).toHaveBeenCalled();
    });
  });

  describe('isCallActive()', () => {
    it('returns true when active call elements are present', async () => {
      mockPage.locator.mockImplementation((selector: string) => {
        if (selector.includes('active-call') || selector.includes('in-call')) {
          return { count: jest.fn().mockResolvedValue(1) } as any;
        }
        return { count: jest.fn().mockResolvedValue(0) } as any;
      });

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
