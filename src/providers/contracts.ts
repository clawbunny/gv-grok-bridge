/**
 * Provider contracts — voice and AI provider interfaces.
 * Any new provider implements one of these interfaces and registers itself
 * in the provider factory (src/providers/index.ts).
 */

import type { Page } from 'playwright';
import type { Logger } from '../logger';
import type { CallInfo } from '../types';

export interface VoiceProvider {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly origin: string;

  /** Initialize the provider page and return whether the user is logged in. */
  initialize(page: Page, logger: Logger): Promise<boolean>;

  /** Check login state without re-initializing. */
  checkLoggedIn(page: Page, logger: Logger): Promise<boolean>;

  /** Detect an incoming call. Return call info or null. */
  detectIncomingCall(page: Page, logger: Logger): Promise<CallInfo | null>;

  /** Programmatically answer the current incoming call. */
  acceptCall(page: Page, logger: Logger): Promise<void>;

  /** Programmatically decline the current incoming call. */
  declineCall(page: Page, logger: Logger): Promise<void>;

  /** Return true if a call is still active. */
  isCallActive(page: Page, logger: Logger): Promise<boolean>;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly origin: string;

  /** Initialize the provider page and return whether the user is logged in. */
  initialize(page: Page, logger: Logger): Promise<boolean>;

  /** Check login state without re-initializing. */
  checkLoggedIn(page: Page, logger: Logger): Promise<boolean>;

  /** Activate voice/speak mode. */
  activateVoiceMode(page: Page, logger: Logger): Promise<boolean>;

  /** Deactivate voice/speak mode. */
  deactivateVoiceMode(page: Page, logger: Logger): Promise<boolean>;

  /** Return true if voice mode is currently active. */
  isVoiceModeActive(): boolean;
}
