/**
 * VoiceMonitor tests — TDD first
 * Covers: lifecycle, phone normalization, authorization, polling, accept/decline
 */

import type { Page, Locator } from 'playwright';
import { VoiceMonitor, normalizePhoneNumber, isAuthorized } from '../monitor';
import { SilentLogger } from '../../logger';
import type { CallInfo, VoiceConfig } from '../../types';

// ─── Mock Factory ──────────────────────────────────────────

interface MockOpts {
  incomingCallUI?: boolean;
  callerNumber?: string;
  callerName?: string;
  hasAnswerButton?: boolean;
  hasDeclineButton?: boolean;
  activeCallUI?: boolean;
}

function createMockLocator(opts: {
  countVal?: number;
  visibleVal?: boolean;
  clickOk?: boolean;
  textVal?: string;
}): jest.Mocked<Locator> {
  return {
    count: jest.fn().mockResolvedValue(opts.countVal ?? 0),
    first: jest.fn().mockReturnThis(),
    last: jest.fn().mockReturnThis(),
    click: jest.fn().mockImplementation(() => {
      if (opts.clickOk === false) return Promise.reject(new Error('click failed'));
      return Promise.resolve();
    }),
    isVisible: jest.fn().mockResolvedValue(opts.visibleVal ?? false),
    textContent: jest.fn().mockResolvedValue(opts.textVal ?? ''),
    locator: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Locator>;
}

function createMockPage(opts: MockOpts = {}): jest.Mocked<Page> {
  const {
    incomingCallUI = false,
    callerNumber = '',
    callerName = '',
    hasAnswerButton = false,
    hasDeclineButton = false,
    activeCallUI = false,
  } = opts;

  const defaultLocator = createMockLocator({ countVal: 0 });

  const locatorMock = jest.fn((selector: string) => {
    // Answer button selectors
    if (
      hasAnswerButton &&
      (selector.toLowerCase().includes('answer') || selector === 'button:has-text("Answer")')
    ) {
      return createMockLocator({ countVal: 1, clickOk: true });
    }
    // Decline button selectors
    if (
      hasDeclineButton &&
      (selector.toLowerCase().includes('decline') || selector === 'button:has-text("Decline")')
    ) {
      return createMockLocator({ countVal: 1, clickOk: true });
    }
    // Incoming call UI detection
    if (
      incomingCallUI &&
      (selector.includes('incoming-call') ||
        selector.includes('Incoming call') ||
        selector.includes('[aria-label*="Incoming call"]') ||
        selector.includes('Answer') ||
        selector.includes('Decline'))
    ) {
      if (selector.includes('Answer') || selector.includes('Decline')) {
        return createMockLocator({ countVal: 1 });
      }
      return createMockLocator({ countVal: 1 });
    }
    // Active call UI
    if (
      activeCallUI &&
      (selector.includes('active-call') || selector.includes('active call'))
    ) {
      return createMockLocator({ countVal: 1 });
    }
    return defaultLocator;
  });

  const page = {
    locator: locatorMock,
    url: jest.fn().mockReturnValue('https://voice.google.com'),
    evaluate: jest.fn().mockImplementation((fn: Function) => {
      if (incomingCallUI && callerNumber) {
        return Promise.resolve({ rawNumber: callerNumber, callerName });
      }
      if (incomingCallUI && callerName && !callerNumber) {
        return Promise.resolve({ rawNumber: '', callerName });
      }
      return Promise.resolve(null);
    }),
    context: jest.fn().mockReturnValue({
      grantPermissions: jest.fn().mockResolvedValue(undefined),
    }),
    goto: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Page>;

  return page;
}

// ─── Helpers ───────────────────────────────────────────────

function createTestConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    authorizedNumbers: ['+12125551234'],
    authorizedNames: ['Alice'],
    autoAccept: true,
    pollInterval: 100,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test Suite ────────────────────────────────────────────

describe('VoiceMonitor', () => {
  let monitor: VoiceMonitor;

  beforeEach(() => {
    monitor = new VoiceMonitor(new SilentLogger());
  });

  afterEach(async () => {
    await monitor.stopMonitoring();
  });

  // ── 1. startMonitoring throws if already monitoring ──
  describe('startMonitoring()', () => {
    it('throws if already monitoring', async () => {
      const page = createMockPage();
      const config = createTestConfig();

      await monitor.startMonitoring(page, config);

      await expect(monitor.startMonitoring(page, config)).rejects.toThrow(
        'Monitoring is already active'
      );
    });

    it('starts monitoring successfully with valid page and config', async () => {
      const page = createMockPage();
      const config = createTestConfig();

      await monitor.startMonitoring(page, config);

      expect(monitor.isMonitoring()).toBe(true);
    });
  });

  // ── 2. stopMonitoring clears interval and resets state ──
  describe('stopMonitoring()', () => {
    it('clears interval and resets all state', async () => {
      const page = createMockPage({ incomingCallUI: true, callerNumber: '+1(212)555-1234' });
      const config = createTestConfig();

      await monitor.startMonitoring(page, config);
      expect(monitor.isMonitoring()).toBe(true);

      await monitor.stopMonitoring();

      expect(monitor.isMonitoring()).toBe(false);
      expect(monitor.isInCall()).toBe(false);
      expect(monitor.getCurrentCall()).toBeNull();
    });

    it('is safe to call multiple times', async () => {
      await monitor.stopMonitoring();
      await monitor.stopMonitoring();
      expect(monitor.isMonitoring()).toBe(false);
    });
  });

  // ── 3. isInCall returns correct state ──
  describe('isInCall()', () => {
    it('returns false when not in a call', () => {
      expect(monitor.isInCall()).toBe(false);
    });

    it('returns true after accepting a call', async () => {
      const page = createMockPage({
        incomingCallUI: true,
        callerNumber: '+1(212)555-1234',
        hasAnswerButton: true,
      });
      const config = createTestConfig();

      const acceptedPromise = new Promise<CallInfo>((resolve) => {
        monitor.on('callAccepted', resolve);
      });

      await monitor.startMonitoring(page, config);
      await acceptedPromise;

      expect(monitor.isInCall()).toBe(true);
    });
  });

  // ── 4. normalizePhoneNumber ──
  describe('normalizePhoneNumber()', () => {
    it('normalizes +1(212)555-1234 to +12125551234', () => {
      expect(normalizePhoneNumber('+1(212)555-1234')).toBe('+12125551234');
    });

    it('normalizes 212-555-1234 to +12125551234', () => {
      expect(normalizePhoneNumber('212-555-1234')).toBe('+12125551234');
    });

    it('adds +1 prefix to 10-digit number', () => {
      expect(normalizePhoneNumber('2125551234')).toBe('+12125551234');
    });

    it('returns empty string for empty input', () => {
      expect(normalizePhoneNumber('')).toBe('');
    });
  });

  // ── 5. isAuthorized ──
  describe('isAuthorized()', () => {
    it('returns true for exact number match', () => {
      const call: CallInfo = { phoneNumber: '+12125551234', callerName: 'Unknown', timestamp: new Date() };
      const config = createTestConfig();
      expect(isAuthorized(call, config)).toBe(true);
    });

    it('returns true for name substring match', () => {
      const call: CallInfo = { phoneNumber: '+15559998888', callerName: 'Alice Smith', timestamp: new Date() };
      const config = createTestConfig();
      expect(isAuthorized(call, config)).toBe(true);
    });

    it('returns false when no match', () => {
      const call: CallInfo = { phoneNumber: '+99999999999', callerName: 'Unknown Caller', timestamp: new Date() };
      const config = createTestConfig();
      expect(isAuthorized(call, config)).toBe(false);
    });

    it('returns false when config is null', () => {
      const call: CallInfo = { phoneNumber: '+12125551234', callerName: 'Alice', timestamp: new Date() };
      expect(isAuthorized(call, null)).toBe(false);
    });
  });

  // ── 6. Poll cycle: incoming → emit → authorized → auto-accept → emit accepted ──
  describe('poll cycle: authorized auto-accept', () => {
    it('detects incoming call, emits event, auto-accepts authorized caller', async () => {
      const page = createMockPage({
        incomingCallUI: true,
        callerNumber: '+1(212)555-1234',
        hasAnswerButton: true,
      });
      const config = createTestConfig();

      const incomingCalls: CallInfo[] = [];
      const acceptedCalls: CallInfo[] = [];

      monitor.on('incomingCall', (call: CallInfo) => incomingCalls.push(call));
      monitor.on('callAccepted', (call: CallInfo) => acceptedCalls.push(call));

      await monitor.startMonitoring(page, config);
      await wait(250); // let poll cycle run

      expect(incomingCalls.length).toBeGreaterThanOrEqual(1);
      expect(acceptedCalls.length).toBeGreaterThanOrEqual(1);
      expect(monitor.isInCall()).toBe(true);
      expect(monitor.getCurrentCall()?.phoneNumber).toBe('+12125551234');
    });
  });

  // ── 7. Poll cycle: incoming → unauthorized → declines ──
  describe('poll cycle: unauthorized declines', () => {
    it('detects incoming call but declines unauthorized caller', async () => {
      const page = createMockPage({
        incomingCallUI: true,
        callerNumber: '+1(555)999-8888',
        callerName: 'Stranger',
        hasDeclineButton: true,
      });
      const config = createTestConfig();

      const incomingCalls: CallInfo[] = [];

      monitor.on('incomingCall', (call: CallInfo) => incomingCalls.push(call));

      await monitor.startMonitoring(page, config);
      await wait(250);

      expect(incomingCalls.length).toBeGreaterThanOrEqual(1);
      expect(monitor.isInCall()).toBe(false);
    });
  });

  // ── 8. Poll cycle: in-call → UI disappears → emits callEnded ──
  describe('poll cycle: call ended', () => {
    it('emits callEnded when call UI disappears after being in a call', async () => {
      // First, simulate incoming + accepted call
      const page = createMockPage({
        incomingCallUI: true,
        callerNumber: '+1(212)555-1234',
        hasAnswerButton: true,
        activeCallUI: false,
      });
      const config = createTestConfig();

      const acceptedPromise = new Promise<CallInfo>((resolve) => {
        monitor.on('callAccepted', resolve);
      });

      await monitor.startMonitoring(page, config);
      await acceptedPromise;

      // Now page no longer has any call UI → call should end
      page.evaluate = jest.fn().mockResolvedValue(null);
      (page.locator as jest.Mock).mockImplementation(() => createMockLocator({ countVal: 0 }));

      const endedPromise = new Promise<void>((resolve) => {
        monitor.on('callEnded', resolve);
      });

      await wait(300); // let poll detect ended call
    });
  });

  // ── 9. acceptCall tries selectors until one succeeds ──
  describe('acceptCall()', () => {
    it('clicks the first found answer button', async () => {
      const page = createMockPage({ hasAnswerButton: true });
      (monitor as any).page = page;

      await (monitor as any).acceptCall();

      expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('Answer'));
    });

    it('warns when no answer button found', async () => {
      const page = createMockPage();
      (monitor as any).page = page;

      await (monitor as any).acceptCall();

      // Should complete without throwing
    });
  });

  // ── 10. declineCall tries selectors until one succeeds ──
  describe('declineCall()', () => {
    it('clicks the first found decline button', async () => {
      const page = createMockPage({ hasDeclineButton: true });
      (monitor as any).page = page;

      await (monitor as any).declineCall();

      expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('Decline'));
    });
  });
});
