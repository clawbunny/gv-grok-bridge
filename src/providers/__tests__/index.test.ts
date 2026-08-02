/**
 * Provider factory tests.
 */

import { getVoiceProvider, getAIProvider, listVoiceProviders, listAIProviders } from '../index';
import { GoogleVoiceProvider } from '../voice/google-voice/provider';
import { TwilioVoiceProvider } from '../voice/twilio/provider';
import { TextNowVoiceProvider } from '../voice/textnow/provider';
import { GrokProvider } from '../ai/grok/provider';
import { ChatGptProvider } from '../ai/chatgpt/provider';

describe('Provider factory', () => {
  describe('getVoiceProvider', () => {
    it('returns a GoogleVoiceProvider for "google-voice"', () => {
      const provider = getVoiceProvider('google-voice');
      expect(provider).toBeInstanceOf(GoogleVoiceProvider);
    });

    it('returns a TwilioVoiceProvider for "twilio"', () => {
      const provider = getVoiceProvider('twilio');
      expect(provider).toBeInstanceOf(TwilioVoiceProvider);
    });

    it('returns a TextNowVoiceProvider for "textnow"', () => {
      const provider = getVoiceProvider('textnow');
      expect(provider).toBeInstanceOf(TextNowVoiceProvider);
    });

    it('passes cookiePath config to Google Voice provider', () => {
      const provider = getVoiceProvider('google-voice', { cookiePath: '/tmp/gv-cookies.json' });
      expect(provider).toBeInstanceOf(GoogleVoiceProvider);
    });

    it('passes cookiePath config to TextNow provider', () => {
      const provider = getVoiceProvider('textnow', { cookiePath: '/tmp/cookies.json' });
      expect(provider).toBeInstanceOf(TextNowVoiceProvider);
      // The cookiePath is private; we test behavior via initialize in provider tests.
    });

    it('throws for unknown voice provider', () => {
      expect(() => getVoiceProvider('unknown')).toThrow('Unknown voice provider');
    });
  });

  describe('getAIProvider', () => {
    it('returns a GrokProvider for "grok"', () => {
      const provider = getAIProvider('grok');
      expect(provider).toBeInstanceOf(GrokProvider);
    });

    it('returns a ChatGptProvider for "chatgpt"', () => {
      const provider = getAIProvider('chatgpt');
      expect(provider).toBeInstanceOf(ChatGptProvider);
    });

    it('throws for unknown AI provider', () => {
      expect(() => getAIProvider('unknown')).toThrow('Unknown AI provider');
    });
  });

  describe('listVoiceProviders', () => {
    it('includes google-voice, twilio, and textnow', () => {
      const providers = listVoiceProviders();
      expect(providers).toContain('google-voice');
      expect(providers).toContain('twilio');
      expect(providers).toContain('textnow');
    });
  });

  describe('listAIProviders', () => {
    it('includes grok and chatgpt', () => {
      const providers = listAIProviders();
      expect(providers).toContain('grok');
      expect(providers).toContain('chatgpt');
    });
  });
});
