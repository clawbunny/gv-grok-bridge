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
    evaluate: jest.fn().mockResolvedValue(null),
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

    it('returns false when no decisive signal appears (greeting text is not proof)', async () => {
      // Regression guard: the old heuristic treated greeting text like
      // "Good morning" as logged-in, which false-positived on the public
      // landing page and raced page init after reloads. Only a visible
      // composer counts as logged in now.
      const page = createMockPage({
        loginVisible: false,
        chatInputVisible: false,
        bodyText: 'Good morning',
      });
      const result = await provider.checkLoggedIn(page, silentLogger as any);
      expect(result).toBe(false);
    });
  });

  describe('voice mode state', () => {
    it('starts with voice mode inactive', () => {
      expect(provider.isVoiceModeActive()).toBe(false);
    });

    it('tracks voice mode as active after successful activation', async () => {
      const page = createMockPage();
      const click = jest.fn().mockResolvedValue(undefined);
      page.locator = jest.fn().mockImplementation(() => ({
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockReturnThis(),
        click,
        isVisible: jest.fn().mockResolvedValue(true),
      }));

      const result = await provider.activateVoiceMode(page, silentLogger as any);
      expect(result).toBe(true);
      expect(provider.isVoiceModeActive()).toBe(true);
      expect(click).toHaveBeenCalledWith(expect.objectContaining({ noWaitAfter: true }));
      expect(page.keyboard.press).not.toHaveBeenCalledWith('Control+Shift+O');
    });

    it('does not press the keyboard shortcut after a click that already landed', async () => {
      const page = createMockPage();
      const click = jest.fn().mockRejectedValue(
        new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - performing click action\n  - click action done\n  - waiting for scheduled navigations to finish'),
      );
      page.locator = jest.fn().mockImplementation((selector: string) => ({
        count: jest.fn().mockResolvedValue(/voice|microphone/i.test(selector) ? 1 : 0),
        first: jest.fn().mockReturnThis(),
        click,
        isVisible: jest.fn().mockResolvedValue(true),
      }));

      const result = await provider.activateVoiceMode(page, silentLogger as any);
      expect(result).toBe(true);
      expect(provider.isVoiceModeActive()).toBe(true);
      expect(page.keyboard.press).not.toHaveBeenCalledWith('Control+Shift+O');
    });

    it('falls back to the keyboard shortcut only when the click never happened', async () => {
      const page = createMockPage();
      page.locator = jest.fn().mockImplementation((selector: string) => ({
        count: jest.fn().mockResolvedValue(/voice|microphone/i.test(selector) ? 1 : 0),
        first: jest.fn().mockReturnThis(),
        click: jest.fn().mockRejectedValue(new Error('element is not attached')),
        isVisible: jest.fn().mockResolvedValue(true),
      }));

      const result = await provider.activateVoiceMode(page, silentLogger as any);
      expect(result).toBe(true);
      expect(page.keyboard.press).toHaveBeenCalledWith('Control+Shift+O');
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
          const isEnterVoice = /Enter voice mode/i.test(selector);
          const isActiveIndicator =
            !isEnterVoice && /stop|end|mute|voice.*active|listening|orb/i.test(selector);
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

    it('returns true when RTC hooks report a live audio track and a connected peer', async () => {
      const page = {
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue({ liveAudioTrack: true, connectedPeer: true }),
        locator: jest.fn().mockImplementation(() => ({
          count: jest.fn().mockResolvedValue(0),
          first: jest.fn().mockReturnThis(),
          isVisible: jest.fn().mockResolvedValue(false),
          textContent: jest.fn().mockResolvedValue(''),
        })),
      } as any;
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(true);
    });

    it('still accepts a live mic track if the peer has not connected by the deadline', async () => {
      const page = {
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue({ liveAudioTrack: true, connectedPeer: false }),
        locator: jest.fn().mockImplementation(() => ({
          count: jest.fn().mockResolvedValue(0),
          first: jest.fn().mockReturnThis(),
          isVisible: jest.fn().mockResolvedValue(false),
          textContent: jest.fn().mockResolvedValue(''),
        })),
      } as any;
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(true);
    });

    it('returns false when RTC hooks only report a leftover connected peer', async () => {
      // A previous call's RTCPeerConnection can stay "connected" after
      // voice is toggled off. That must not count as a new session.
      const page = {
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue({ liveAudioTrack: false, connectedPeer: true }),
        locator: jest.fn().mockImplementation(() => ({
          count: jest.fn().mockResolvedValue(0),
          first: jest.fn().mockReturnThis(),
          isVisible: jest.fn().mockResolvedValue(false),
          textContent: jest.fn().mockResolvedValue(''),
        })),
      } as any;
      const result = await provider.verifyVoiceSession(page, silentLogger as any);
      expect(result).toBe(false);
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
