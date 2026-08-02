/**
 * Provider factory — registers and resolves voice/AI providers.
 */

import type { VoiceProvider, AIProvider } from './contracts';
import { GoogleVoiceProvider } from './voice/google-voice/provider';
import { TwilioVoiceProvider } from './voice/twilio/provider';
import { TextNowVoiceProvider } from './voice/textnow/provider';
import { GrokProvider } from './ai/grok/provider';
import { ChatGptProvider } from './ai/chatgpt/provider';

const voiceProviders = new Map<string, (config?: Record<string, unknown>) => VoiceProvider>([
  ['google-voice', (config) => new GoogleVoiceProvider(config?.cookiePath as string | undefined)],
  ['twilio', () => new TwilioVoiceProvider()],
  ['textnow', (config) => new TextNowVoiceProvider(config?.cookiePath as string | undefined)],
]);

const aiProviders = new Map<string, (config?: Record<string, unknown>) => AIProvider>([
  ['grok', () => new GrokProvider()],
  ['chatgpt', () => new ChatGptProvider()],
]);

export function getVoiceProvider(type: string, config?: Record<string, unknown>): VoiceProvider {
  const factory = voiceProviders.get(type);
  if (!factory) {
    throw new Error(
      `Unknown voice provider "${type}". Available: ${Array.from(voiceProviders.keys()).join(', ')}`
    );
  }
  return factory(config);
}

export function getAIProvider(type: string, config?: Record<string, unknown>): AIProvider {
  const factory = aiProviders.get(type);
  if (!factory) {
    throw new Error(
      `Unknown AI provider "${type}". Available: ${Array.from(aiProviders.keys()).join(', ')}`
    );
  }
  return factory(config);
}

export function listVoiceProviders(): string[] {
  return Array.from(voiceProviders.keys());
}

export function listAIProviders(): string[] {
  return Array.from(aiProviders.keys());
}
