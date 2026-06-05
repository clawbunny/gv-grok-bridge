/**
 * GrokController tests — TDD first
 * Covers: init, login check, voice mode activate/deactivate, state queries
 */

import type { Page, BrowserContext, Locator } from 'playwright';
import { GrokController } from '../controller';
import { SilentLogger } from '../../logger';

// ─── Mock Factory ──────────────────────────────────────────

interface MockOpts {
  hasLoginButton?: boolean;
  hasChatInput?: boolean;
  hasMicButton?: boolean;
  hasStopButton?: boolean;
  url?: string;
}

function createMockLocator(opts: {
  countVal?: number;
  visibleVal?: boolean;
  clickOk?: boolean;
} = {}): jest.Mocked<Locator> {
  return {
    count: jest.fn().mockResolvedValue(opts.countVal ?? 0),
    first: jest.fn().mockReturnThis(),
    last: jest.fn().mockReturnThis(),
    click: jest.fn().mockImplementation(() => {
      if (opts.clickOk === false) return Promise.reject(new Error('click failed'));
      return Promise.resolve();
    }),
    isVisible: jest.fn().mockResolvedValue(opts.visibleVal ?? false),
  } as unknown as jest.Mocked<Locator>;
}

function createMockPage(opts: MockOpts = {}): jest.Mocked<Page> {
  const {
    hasLoginButton = false,
    hasChatInput = false,
    hasMicButton = false,
    hasStopButton = false,
    url = 'https://grok.com',
  } = opts;

  const locatorMock = jest.fn((selector: string) => {
    const s = selector.toLowerCase();

    // Login button selectors
    if (
      hasLoginButton &&
      (s.includes('log in') || s.includes('sign in') || s.includes('login') || s.includes('auth'))
    ) {
      return createMockLocator({ countVal: 1, visibleVal: true });
    }

    // Chat input selectors
    if (
      hasChatInput &&
      (s.includes('textarea') || s.includes('ask') || s.includes('message') || s.includes('contenteditable'))
    ) {
      return createMockLocator({ countVal: 1, visibleVal: true });
    }

    // Mic button selectors (aria-label)
    if (
      hasMicButton &&
      (s.includes('microphone') || s.includes('voice') || s.includes('mic') || s.includes('speak'))
    ) {
      return createMockLocator({ countVal: 1, visibleVal: true, clickOk: true });
    }

    // Stop button selectors
    if (
      hasStopButton &&
      (s.includes('stop') || s.includes('cancel') || s.includes('keyboard') || s.includes('end'))
    ) {
      return createMockLocator({ countVal: 1, visibleVal: true, clickOk: true });
    }

    return createMockLocator({ countVal: 0 });
  });

  return {
    locator: locatorMock,
    url: jest.fn().mockReturnValue(url),
    goto: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    context: jest.fn().mockReturnValue({
      grantPermissions: jest.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext),
  } as unknown as jest.Mocked<Page>;
}

// ─── Test Suite ────────────────────────────────────────────

describe('GrokController', () => {
  let controller: GrokController;

  beforeEach(() => {
    controller = new GrokController(new SilentLogger());
  });

  // ── 1. initialize grants mic permissions and returns login state ──
  describe('initialize()', () => {
    it('grants microphone permissions and returns true when logged in', async () => {
      const page = createMockPage({ hasChatInput: true });
      const ctxGrantMock = jest.fn().mockResolvedValue(undefined);
      (page.context as jest.Mock).mockReturnValue({ grantPermissions: ctxGrantMock });

      const result = await controller.initialize(page);

      expect(ctxGrantMock).toHaveBeenCalledWith(['microphone'], { origin: 'https://grok.com' });
      expect(result).toBe(true);
    });

    it('returns false when not logged in', async () => {
      const page = createMockPage({ hasLoginButton: true });
      const result = await controller.initialize(page);
      expect(result).toBe(false);
    });

    it('handles mic permission errors gracefully', async () => {
      const page = createMockPage({ hasChatInput: true });
      const ctxGrantMock = jest.fn().mockRejectedValue(new Error('permission denied'));
      (page.context as jest.Mock).mockReturnValue({ grantPermissions: ctxGrantMock });

      const result = await controller.initialize(page);
      expect(result).toBe(true); // still returns login state
    });
  });

  // ── 2. checkLoggedIn: login button visible → false ──
  describe('checkLoggedIn()', () => {
    it('returns false when login button is visible', async () => {
      const page = createMockPage({ hasLoginButton: true });
      const result = await controller.checkLoggedIn(page);
      expect(result).toBe(false);
    });

    it('returns true when chat input is visible', async () => {
      const page = createMockPage({ hasChatInput: true });
      const result = await controller.checkLoggedIn(page);
      expect(result).toBe(true);
    });

    it('returns false when redirected to login URL', async () => {
      const page = createMockPage({ url: 'https://grok.com/login' });
      const result = await controller.checkLoggedIn(page);
      expect(result).toBe(false);
    });
  });

  // ── 3–5. activateVoiceMode ──
  describe('activateVoiceMode()', () => {
    it('finds mic button, clicks it, returns true', async () => {
      const page = createMockPage({ hasMicButton: true });
      const result = await controller.activateVoiceMode(page);
      expect(result).toBe(true);
      expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('microphone'));
    });

    it('returns false when no mic button found', async () => {
      const page = createMockPage();
      const result = await controller.activateVoiceMode(page);
      expect(result).toBe(false);
    });

    it('finds stop button for deactivation', async () => {
      const page = createMockPage({ hasMicButton: true, hasStopButton: true });
      await controller.activateVoiceMode(page);
      const result = await controller.deactivateVoiceMode(page);
      expect(result).toBe(true);
    });
  });

  // ── 6–7. deactivateVoiceMode ──
  describe('deactivateVoiceMode()', () => {
    it('returns true immediately if already inactive', async () => {
      const page = createMockPage();
      const result = await controller.deactivateVoiceMode(page);
      expect(result).toBe(true);
    });

    it('clicks stop button when voice mode is active', async () => {
      const page = createMockPage({ hasMicButton: true, hasStopButton: true });
      await controller.activateVoiceMode(page);
      expect(controller.isVoiceModeActive()).toBe(true);

      const result = await controller.deactivateVoiceMode(page);
      expect(result).toBe(true);
      expect(controller.isVoiceModeActive()).toBe(false);
    });

    it('toggles mic button when no stop button found', async () => {
      const page = createMockPage({ hasMicButton: true });
      await controller.activateVoiceMode(page);
      expect(controller.isVoiceModeActive()).toBe(true);

      // No stop button, but mic button still present → toggle off
      const result = await controller.deactivateVoiceMode(page);
      expect(result).toBe(true);
      expect(controller.isVoiceModeActive()).toBe(false);
    });
  });

  // ── 8–9. isVoiceModeActive ──
  describe('isVoiceModeActive()', () => {
    it('returns false initially', () => {
      expect(controller.isVoiceModeActive()).toBe(false);
    });

    it('returns true after successful activation', async () => {
      const page = createMockPage({ hasMicButton: true });
      await controller.activateVoiceMode(page);
      expect(controller.isVoiceModeActive()).toBe(true);
    });

    it('returns false after deactivation', async () => {
      const page = createMockPage({ hasMicButton: true });
      await controller.activateVoiceMode(page);
      await controller.deactivateVoiceMode(page);
      expect(controller.isVoiceModeActive()).toBe(false);
    });
  });
});
