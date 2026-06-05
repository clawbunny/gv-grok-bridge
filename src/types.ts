/**
 * Shared TypeScript types for the GV-Grok Bridge
 */

import type { LogLevel } from './logger';
export type { LogLevel };

// ──────────────────────────────────────────
// Audio Pipeline Types
// ──────────────────────────────────────────

export interface AudioDevices {
  /** module ID for pipe_gv_to_grok null-sink */
  gvSink: number;
  /** module ID for pipe_grok_to_gv null-sink */
  grokSink: number;
  /** module ID for src_gv_to_grok remap-source */
  gvSource: number;
  /** module ID for src_grok_to_gv remap-source */
  grokSource: number;
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
  gv: BrowserContext;
  grok: BrowserContext;
  gvPage: Page;
  grokPage: Page;
}

// ──────────────────────────────────────────
// Google Voice Monitor Types
// ──────────────────────────────────────────

export interface VoiceConfig {
  /** List of authorized phone numbers (E.164 format, e.g., +12125551234) */
  authorizedNumbers: string[];
  /** Also accept calls from contacts whose name contains these strings */
  authorizedNames?: string[];
  /** Auto-accept authorized calls */
  autoAccept: boolean;
  /** Poll interval in ms (default: 1000) */
  pollInterval?: number;
}

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
}

export interface BridgeStatus {
  running: boolean;
  audioReady: boolean;
  gvBrowserReady: boolean;
  grokBrowserReady: boolean;
  gvLoggedIn: boolean;
  grokLoggedIn: boolean;
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
  | 'ACTIVATE_GROK'
  | 'BRIDGED'
  | 'CALL_ENDING'
  | 'DEACTIVATE_GROK'
  | 'ERROR'
  | 'SHUTDOWN';
