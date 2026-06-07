/**
 * ChatGPT Provider — stub / placeholder.
 * Implement this when adding ChatGPT voice mode support.
 */

import type { Page } from 'playwright';
import type { Logger } from '../../../logger';
import type { AIProvider } from '../../contracts';

export class ChatGptProvider implements AIProvider {
  readonly id = 'chatgpt';
  readonly name = 'ChatGPT';
  readonly url = 'https://chat.openai.com';
  readonly origin = 'https://chat.openai.com';

  private voiceModeActive = false;

  async initialize(_page: Page, logger: Logger): Promise<boolean> {
    logger.warn('ChatGPT AI provider is not yet implemented.');
    return false;
  }

  async checkLoggedIn(_page: Page, _logger: Logger): Promise<boolean> {
    return false;
  }

  async activateVoiceMode(_page: Page, _logger: Logger): Promise<boolean> {
    throw new Error('ChatGPT activateVoiceMode not implemented');
  }

  async deactivateVoiceMode(_page: Page, _logger: Logger): Promise<boolean> {
    this.voiceModeActive = false;
    return true;
  }

  isVoiceModeActive(): boolean {
    return this.voiceModeActive;
  }
}
