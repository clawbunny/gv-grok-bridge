/**
 * Shared TypeScript types for the GV Bridge
 */

import type { LogLevel } from './logger';
export type { LogLevel };

// ──────────────────────────────────────────
// Provider Types
// ──────────────────────────────────────────

export interface ProviderRef {
  /** Provider type identifier, e.g. 'google-voice' or 'grok' */
  type: string;
  /** Provider-specific configuration object */
  config?: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Audio Pipeline Types
// ──────────────────────────────────────────

export interface AudioDevices {
  /** module ID for voice->ai null-sink */
  voiceSink: number;
  /** module ID for ai->voice null-sink */
  aiSink: number;
  /** module ID for voice->ai remap-source */
  voiceSource: number;
  /** module ID for ai->voice remap-source */
  aiSource: number;
}

// ──────────────────────────────────────────
// Browser Manager Types
// ──────────────────────────────────────────

import type { BrowserContext, Page, CDPSession } from 'playwright';

export { BrowserContext, Page, CDPSession };

export interface BrowserConfig {
  /** Path to default Chromium profile (e.g., /home/user/.config/chromium) */
  defaultProfilePath: string;
  /** Path to copy profile for second browser instance */
  tempProfilePath: string;
  /** Whether to run headless (xvfb) or with display */
  headless: boolean;
  /** xvfb display number if headless (e.g., ":99") */
  displayNum?: string;
  /** Extra chromium args */
  extraArgs?: string[];
}

export interface BrowserPair {
  voice: BrowserContext;
  ai: BrowserContext;
  voicePage: Page;
  aiPage: Page;
}

export interface ProviderBrowserConfig {
  voiceUrl: string;
  aiUrl: string;
  voiceOrigin: string;
  aiOrigin: string;
}

// ──────────────────────────────────────────
// Call Info
// ──────────────────────────────────────────

export interface CallInfo {
  phoneNumber: string;
  callerName: string;
  timestamp: Date;
}

export type VoiceEvent = 'incomingCall' | 'callAccepted' | 'callEnded' | 'error';

export type VoiceEventHandler = {
  incomingCall: (call: CallInfo) => void;
  callAccepted: (call: CallInfo) => void;
  callEnded: () => void;
  error: (err: Error) => void;
};

// ──────────────────────────────────────────
// Bridge Orchestrator Types
// ──────────────────────────────────────────

export interface BridgeConfig {
  /** Instance identifier */
  instanceId: string;
  /** PulseAudio namespace for this instance */
  namespace: string;
  /** Path to default Chromium profile */
  defaultProfilePath: string;
  /** Path to copy profile for second browser instance */
  tempProfilePath: string;
  /** Authorized phone numbers */
  authorizedNumbers: string[];
  /** Also accept calls from contacts whose name contains these strings */
  authorizedNames?: string[];
  /** Headless mode */
  headless: boolean;
  /** xvfb display number */
  displayNum?: string;
  /** Auto-accept authorized calls */
  autoAccept: boolean;
  /** Poll interval for call detection (ms) */
  pollInterval: number;
  /** Extra chromium args */
  extraArgs?: string[];
  /** Log level */
  logLevel: LogLevel;
  /** Voice provider reference */
  voiceProvider: ProviderRef;
  /** AI provider reference */
  aiProvider: ProviderRef;
}

export interface BridgeStatus {
  running: boolean;
  audioReady: boolean;
  voiceBrowserReady: boolean;
  aiBrowserReady: boolean;
  voiceLoggedIn: boolean;
  aiLoggedIn: boolean;
  inCall: boolean;
  currentCall?: CallInfo;
  voiceModeActive: boolean;
}

export type BridgeState =
  | 'INIT'
  | 'SETUP_AUDIO'
  | 'LAUNCH_BROWSERS'
  | 'CHECK_LOGINS'
  | 'IDLE'
  | 'INCOMING_CALL'
  | 'CHECK_AUTH'
  | 'ACCEPT_CALL'
  | 'WAITING_CALL_ACTIVE'
  | 'ACTIVATE_AI'
  | 'BRIDGED'
  | 'CALL_ENDING'
  | 'DEACTIVATE_AI'
  | 'ERROR'
  | 'SHUTDOWN';
