/**
 * Provider factory — registers and resolves voice/AI providers.
 */

import type { VoiceProvider, AIProvider } from './contracts';
import { GoogleVoiceProvider } from './voice/google-voice/provider';
import { TwilioVoiceProvider } from './voice/twilio/provider';
import { GrokProvider } from './ai/grok/provider';
import { ChatGptProvider } from './ai/chatgpt/provider';

const voiceProviders = new Map<string, () => VoiceProvider>([
  ['google-voice', () => new GoogleVoiceProvider()],
  ['twilio', () => new TwilioVoiceProvider()],
]);

const aiProviders = new Map<string, () => AIProvider>([
  ['grok', () => new GrokProvider()],
  ['chatgpt', () => new ChatGptProvider()],
]);

export function getVoiceProvider(type: string): VoiceProvider {
  const factory = voiceProviders.get(type);
  if (!factory) {
    throw new Error(
      `Unknown voice provider "${type}". Available: ${Array.from(voiceProviders.keys()).join(', ')}`
    );
  }
  return factory();
}

export function getAIProvider(type: string): AIProvider {
  const factory = aiProviders.get(type);
  if (!factory) {
    throw new Error(
      `Unknown AI provider "${type}". Available: ${Array.from(aiProviders.keys()).join(', ')}`
    );
  }
  return factory();
}

export function listVoiceProviders(): string[] {
  return Array.from(voiceProviders.keys());
}

export function listAIProviders(): string[] {
  return Array.from(aiProviders.keys());
}
