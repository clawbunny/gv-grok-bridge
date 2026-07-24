/**
 * Grok provider tests — discovered behavior of
 * src/providers/ai/grok/provider.ts
 *
 * These tests document how the provider detects login state and tracks
 * voice-mode activation. The actual page interactions are fragile because
 * they depend on grok.com DOM selectors.
 */

import { GrokProvider } from '../provider';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createMockPage(overrides: {
  url?: string;
  loginVisible?: boolean;
  chatInputVisible?: boolean;
  bodyText?: string;
} = {}) {
  const {
    url = 'https://grok.com',
    loginVisible = false,
    chatInputVisible = true,
    bodyText = 'What do you want to know?',
  } = overrides;

  let currentUrl = url;

  return {
    url: jest.fn().mockImplementation(() => currentUrl),
    goto: jest.fn().mockImplementation((newUrl: string) => {
      currentUrl = newUrl;
      return Promise.resolve(undefined);
    }),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    context: jest.fn().mockReturnValue({
      grantPermissions: jest.fn().mockResolvedValue(undefined),
    }),
    keyboard: { press: jest.fn().mockResolvedValue(undefined) },
    locator: jest.fn().mockImplementation((selector: string) => {
      const isLoginSelector =
        /Log in|Sign in|login-button|aria-label.*login/i.test(selector);
      const isChatSelector =
        /textarea|contenteditable|message-input|Ask|help you|Message|textbox|input/.test(selector);
      const count = isLoginSelector
        ? loginVisible
          ? 1
          : 0
        : isChatSelector
        ? chatInputVisible
          ? 1
          : 0
        : 0;

      return {
        count: jest.fn().mockResolvedValue(count),
        first: jest.fn().mockReturnThis(),
        isVisible: jest.fn().mockResolvedValue(count > 0),
        click: jest.fn().mockResolvedValue(undefined),
        textContent: jest.fn().mockResolvedValue(bodyText),
      };
    }),
  } as any;
}

describe('GrokProvider', () => {
  let provider: GrokProvider;

  beforeEach(() => {
    provider = new GrokProvider();
  });

  describe('provider metadata', () => {
    it('has the expected id, name, url and origin', () => {
      expect(provider.id).toBe('grok');
      expect(provider.name).toBe('Grok');
      expect(provider.url).toBe('https://grok.com');
      expect(provider.origin).toBe('https://grok.com');
    });
  });

  describe('checkLoggedIn()', () => {
    it('returns true when a chat input is visible', async () => {
      const page = createMockPage({ loginVisible: false, chatInputVisible: true });
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(true);
    });

    it('returns false when a login button is visible', async () => {
      const page = createMockPage({ loginVisible: true, chatInputVisible: false });
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(false);
    });

    it('returns false when redirected to a login/auth URL', async () => {
      const page = createMockPage({
        url: 'https://grok.com/login',
        loginVisible: false,
        chatInputVisible: false,
      });
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(false);
    });

    it('returns true when logged-in greeting text is detected', async () => {
      const page = createMockPage({
        loginVisible: false,
        chatInputVisible: false,
        bodyText: 'Good morning',
      });
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(true);
    });
  });

  describe('voice mode state', () => {
    it('starts with voice mode inactive', () => {
      expect(provider.isVoiceModeActive()).toBe(false);
    });

    it('tracks voice mode as active after successful activation', async () => {
      const page = createMockPage();
      page.locator = jest.fn().mockImplementation(() => ({
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockReturnThis(),
        click: jest.fn().mockResolvedValue(undefined),
        isVisible: jest.fn().mockResolvedValue(true),
      }));

      const result = await provider.activateVoiceMode(page, silentLogger as any);
      expect(result).toBe(true);
      expect(provider.isVoiceModeActive()).toBe(true);
    });

    it('tracks voice mode as inactive after deactivation', async () => {
      const page = createMockPage();
      page.locator = jest.fn().mockImplementation(() => ({
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockReturnThis(),
        click: jest.fn().mockResolvedValue(undefined),
        isVisible: jest.fn().mockResolvedValue(true),
      }));

      await provider.activateVoiceMode(page, silentLogger as any);
      expect(provider.isVoiceModeActive()).toBe(true);

      await provider.deactivateVoiceMode(page, silentLogger as any);
      expect(provider.isVoiceModeActive()).toBe(false);
    });

    it('short-circuits deactivation when already inactive', async () => {
      const page = createMockPage();
      const result = await provider.deactivateVoiceMode(page, silentLogger as any);
      expect(result).toBe(true);
      expect(provider.isVoiceModeActive()).toBe(false);
    });
  });

  describe('verifyVoiceSession()', () => {
    function createVerifyMockPage(opts: {
      dialogText?: string | null;
      activeIndicatorVisible?: boolean;
      bodyText?: string;
    }) {
      const { dialogText = null, activeIndicatorVisible = false, bodyText = '' } = opts;
      return {
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation((selector: string) => {
          const isDialog = /role="dialog"|alertdialog|dialog-portal/.test(selector);
          const isActiveIndicator = /stop|end|mute|voice.*active|listening|orb/i.test(selector);
          const isBody = selector === 'body';

          let count = 0;
          let text = '';
          if (isDialog && dialogText !== null) {
            count = 1;
            text = dialogText;
          } else if (isActiveIndicator && activeIndicatorVisible) {
            count = 1;
          } else if (isBody) {
            text = bodyText;
          }

          return {
            count: jest.fn().mockResolvedValue(count),
            first: jest.fn().mockReturnThis(),
            isVisible: jest.fn().mockResolvedValue(count > 0),
            textContent: jest.fn().mockResolvedValue(text),
          };
        }),
      } as any;
    }

    it('returns true when a voice-session indicator is visible', async () => {
      const page = createVerifyMockPage({ activeIndicatorVisible: true });
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(true);
    });

    it('returns false when a quota/upsell dialog is shown', async () => {
      const page = createVerifyMockPage({
        dialogText: 'Upgrade to SuperGrok for more voice credits',
      });
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(false);
    });

    it('returns false when no voice-session indicator appears', async () => {
      const page = createVerifyMockPage({ bodyText: 'What do you want to know?' });
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(false);
    });

    it('returns false on page errors', async () => {
      const page = {
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation(() => {
          throw new Error('page closed');
        }),
      } as any;
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(false);
    });
  });
});
