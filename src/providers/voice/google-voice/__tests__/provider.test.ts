/**
 * Google Voice provider tests — discovered behavior of
 * src/providers/voice/google-voice/provider.ts
 *
 * These tests document how the provider decides whether a user is logged in,
 * how it extracts/normalizes phone numbers from the DOM, and how it authorizes
 * callers by number or by name.
 */

import { GoogleVoiceProvider, normalizePhoneNumber, isAuthorized } from '../provider';
import type { CallInfo } from '../../../../types';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createMockPage(urlValue: string, evaluateResult: unknown = null) {
  return {
    url: jest.fn().mockReturnValue(urlValue),
    context: jest.fn().mockReturnValue({
      grantPermissions: jest.fn().mockResolvedValue(undefined),
    }),
    locator: jest.fn().mockImplementation((selector: string) => ({
      count: jest.fn().mockResolvedValue(0),
      first: jest.fn().mockReturnThis(),
      click: jest.fn().mockResolvedValue(undefined),
      isVisible: jest.fn().mockResolvedValue(false),
      textContent: jest.fn().mockResolvedValue(''),
    })),
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
    keyboard: { press: jest.fn().mockResolvedValue(undefined) },
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('GoogleVoiceProvider', () => {
  let provider: GoogleVoiceProvider;

  beforeEach(() => {
    provider = new GoogleVoiceProvider();
  });

  describe('provider metadata', () => {
    it('has the expected id, name, url and origin', () => {
      expect(provider.id).toBe('google-voice');
      expect(provider.name).toBe('Google Voice');
      expect(provider.url).toBe('https://voice.google.com');
      expect(provider.origin).toBe('https://voice.google.com');
    });
  });

  describe('checkLoggedIn()', () => {
    it('returns true when URL is on voice.google.com and not on accounts.google.com', async () => {
      const page = createMockPage('https://voice.google.com/u/0/calls');
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(true);
    });

    it('returns false when URL contains accounts.google.com', async () => {
      const page = createMockPage('https://accounts.google.com/signin');
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(false);
    });

    it('returns false when not on voice.google.com', async () => {
      const page = createMockPage('https://example.com');
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(false);
    });
  });

  describe('detectIncomingCall()', () => {
    it('returns null when no call UI is visible', async () => {
      const page = createMockPage('https://voice.google.com');
      page.locator = jest.fn().mockImplementation(() => ({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnThis(),
      }));
      const result = await provider.detectIncomingCall(page, silentLogger as any);
      expect(result).toBeNull();
    });

    it('returns normalized caller info when the call UI is visible', async () => {
      const page = createMockPage('https://voice.google.com');
      page.locator = jest.fn().mockImplementation((selector: string) => ({
        count: jest.fn().mockResolvedValue(selector.includes('active-call-wrapper') ? 1 : 0),
        first: jest.fn().mockReturnThis(),
      }));
      page.evaluate = jest.fn().mockResolvedValue({
        rawNumber: '(408) 550-6532',
        callerName: '',
        source: 'active-wrapper',
      });

      const result = await provider.detectIncomingCall(page, silentLogger as any);
      expect(result).not.toBeNull();
      expect(result!.phoneNumber).toBe('+14085506532');
      expect(result!.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('normalizePhoneNumber()', () => {
    it('normalizes 10-digit US numbers to +1 format', () => {
      expect(normalizePhoneNumber('408-550-6532')).toBe('+14085506532');
    });

    it('preserves the leading 1 on 11-digit numbers', () => {
      expect(normalizePhoneNumber('+1 408-550-6532')).toBe('+14085506532');
    });

    it('returns + international numbers unchanged', () => {
      expect(normalizePhoneNumber('+442071838750')).toBe('+442071838750');
    });

    it('returns empty string for empty input', () => {
      expect(normalizePhoneNumber('')).toBe('');
    });
  });

  describe('isAuthorized()', () => {
    const call: CallInfo = {
      phoneNumber: '+14085506532',
      callerName: 'Alice Smith',
      timestamp: new Date(),
    };

    it('authorizes by exact phone number', () => {
      expect(isAuthorized(call, ['+14085506532'])).toBe(true);
    });

    it('denies calls from numbers not in the allow list', () => {
      expect(isAuthorized(call, ['+15551234567'])).toBe(false);
    });

    it('authorizes by substring match on caller name', () => {
      expect(isAuthorized(call, [], ['alice'])).toBe(true);
    });

    it('is case-insensitive for authorized names', () => {
      expect(isAuthorized(call, [], ['ALICE'])).toBe(true);
    });

    it('denies when no lists are provided', () => {
      expect(isAuthorized(call, [])).toBe(false);
    });
  });
});
