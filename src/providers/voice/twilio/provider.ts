/**
 * Twilio Voice Provider — stub / placeholder.
 * Implement this when adding Twilio SIP/WebRTC support.
 */

import type { Page } from 'playwright';
import type { Logger } from '../../../logger';
import type { CallInfo } from '../../../types';
import type { VoiceProvider } from '../../contracts';

export class TwilioVoiceProvider implements VoiceProvider {
  readonly id = 'twilio';
  readonly name = 'Twilio';
  readonly url = 'about:blank';
  readonly origin = 'https://console.twilio.com';

  async initialize(_page: Page, logger: Logger): Promise<boolean> {
    logger.warn('Twilio voice provider is not yet implemented.');
    return false;
  }

  async checkLoggedIn(_page: Page, _logger: Logger): Promise<boolean> {
    return false;
  }

  async detectIncomingCall(_page: Page, _logger: Logger): Promise<CallInfo | null> {
    return null;
  }

  async acceptCall(_page: Page, _logger: Logger): Promise<void> {
    throw new Error('Twilio acceptCall not implemented');
  }

  async declineCall(_page: Page, _logger: Logger): Promise<void> {
    throw new Error('Twilio declineCall not implemented');
  }

  async isCallActive(_page: Page, _logger: Logger): Promise<boolean> {
    return false;
  }
}
