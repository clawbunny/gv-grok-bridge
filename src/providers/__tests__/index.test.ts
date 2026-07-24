/**
 * Provider factory tests — discovered behavior of src/providers/index.ts
 *
 * These tests document how voice and AI providers are registered and resolved.
 * Adding a new provider means registering a factory in these maps.
 */

import { getVoiceProvider, getAIProvider, listVoiceProviders, listAIProviders } from '../index';

describe('Provider factory', () => {
  describe('voice providers', () => {
    it('resolves google-voice provider', () => {
      const provider = getVoiceProvider('google-voice');
      expect(provider.id).toBe('google-voice');
      expect(provider.name).toBe('Google Voice');
      expect(provider.url).toBe('https://voice.google.com');
    });

    it('resolves twilio provider', () => {
      const provider = getVoiceProvider('twilio');
      expect(provider.id).toBe('twilio');
    });

    it('lists available voice providers', () => {
      expect(listVoiceProviders()).toEqual(['google-voice', 'twilio']);
    });

    it('throws for unknown voice provider', () => {
      expect(() => getVoiceProvider('unknown')).toThrow(
        'Unknown voice provider "unknown". Available: google-voice, twilio'
      );
    });
  });

  describe('AI providers', () => {
    it('resolves grok provider', () => {
      const provider = getAIProvider('grok');
      expect(provider.id).toBe('grok');
      expect(provider.name).toBe('Grok');
      expect(provider.url).toBe('https://grok.com');
    });

    it('resolves chatgpt provider', () => {
      const provider = getAIProvider('chatgpt');
      expect(provider.id).toBe('chatgpt');
    });

    it('lists available AI providers', () => {
      expect(listAIProviders()).toEqual(['grok', 'chatgpt']);
    });

    it('throws for unknown AI provider', () => {
      expect(() => getAIProvider('unknown')).toThrow(
        'Unknown AI provider "unknown". Available: grok, chatgpt'
      );
    });
  });
});
