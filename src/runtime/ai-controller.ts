/**
 * Generic AI Controller — delegates all provider-specific logic to an AIProvider.
 */

import type { Page } from 'playwright';
import type { Logger } from '../logger';
import { SilentLogger } from '../logger';
import type { AIProvider } from '../providers/contracts';

export class AIController {
  private provider: AIProvider | null;
  private logger: Logger;

  constructor(logger: Logger = new SilentLogger()) {
    this.provider = null;
    this.logger = logger;
  }

  async initialize(page: Page, provider: AIProvider): Promise<boolean> {
    this.provider = provider;
    return provider.initialize(page, this.logger);
  }

  async checkLoggedIn(page: Page): Promise<boolean> {
    if (!this.provider) return false;
    return this.provider.checkLoggedIn(page, this.logger);
  }

  async activateVoiceMode(page: Page): Promise<boolean> {
    if (!this.provider) {
      this.logger.error('No AI provider set');
      return false;
    }
    return this.provider.activateVoiceMode(page, this.logger);
  }

  async deactivateVoiceMode(page: Page): Promise<boolean> {
    if (!this.provider) {
      this.logger.error('No AI provider set');
      return false;
    }
    return this.provider.deactivateVoiceMode(page, this.logger);
  }

  isVoiceModeActive(): boolean {
    return this.provider?.isVoiceModeActive() ?? false;
  }
}
