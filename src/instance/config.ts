/**
 * Instance configuration schema, validation, and default values.
 */

import * as path from 'path';
import * as os from 'os';
import type { LogLevel, ProviderRef } from '../types';

const DEFAULT_PROFILE = path.join(os.homedir(), '.config', 'chromium');

export interface InstanceConfig {
  instanceId: string;
  voiceProvider: ProviderRef;
  aiProvider: ProviderRef;
  authorizedNumbers: string[];
  authorizedNames?: string[];
  headless: boolean;
  displayNum?: string;
  autoAccept: boolean;
  pollInterval: number;
  logLevel: LogLevel;
  profilePath?: string;
  extraArgs?: string[];
}

export function createDefaultConfig(instanceId: string): InstanceConfig {
  return {
    instanceId,
    voiceProvider: { type: 'google-voice' },
    aiProvider: { type: 'grok' },
    authorizedNumbers: [],
    authorizedNames: [],
    headless: true,
    autoAccept: true,
    pollInterval: 1000,
    logLevel: 'info',
    profilePath: DEFAULT_PROFILE,
  };
}

export function validateInstanceConfig(config: InstanceConfig): string[] {
  const errors: string[] = [];

  if (!config.instanceId || !/^[a-zA-Z0-9_-]+$/.test(config.instanceId)) {
    errors.push('instanceId must be a non-empty slug with only letters, numbers, underscores, and hyphens.');
  }

  if (!config.voiceProvider || !config.voiceProvider.type) {
    errors.push('voiceProvider.type is required.');
  }

  if (!config.aiProvider || !config.aiProvider.type) {
    errors.push('aiProvider.type is required.');
  }

  if (config.authorizedNumbers.length === 0 && (!config.authorizedNames || config.authorizedNames.length === 0)) {
    errors.push('At least one authorized number or name must be configured.');
  }

  if (config.pollInterval < 100) {
    errors.push('pollInterval must be at least 100ms.');
  }

  return errors;
}

export function instanceConfigToBridgeConfig(config: InstanceConfig): import('../types').BridgeConfig {
  return {
    instanceId: config.instanceId,
    namespace: config.instanceId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    defaultProfilePath: config.profilePath || DEFAULT_PROFILE,
    tempProfilePath: path.join(os.tmpdir(), 'gv-bridge', config.instanceId, 'chromium-copy'),
    authorizedNumbers: config.authorizedNumbers,
    authorizedNames: config.authorizedNames,
    headless: config.headless,
    displayNum: config.displayNum,
    autoAccept: config.autoAccept,
    pollInterval: config.pollInterval,
    extraArgs: config.extraArgs,
    logLevel: config.logLevel,
    voiceProvider: config.voiceProvider,
    aiProvider: config.aiProvider,
  };
}
