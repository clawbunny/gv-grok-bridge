/**
 * Configuration loader — environment variables + CLI args
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { BridgeConfig, LogLevel } from './types';

const DEFAULT_PROFILE = path.join(os.homedir(), '.config', 'chromium');
const TEMP_PROFILE = path.join(os.tmpdir(), 'gv-grok-bridge', 'chromium-copy');

function parseNumbers(input?: string): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(): BridgeConfig {
  return {
    defaultProfilePath: process.env.GV_PROFILE_PATH || DEFAULT_PROFILE,
    tempProfilePath: TEMP_PROFILE,
    authorizedNumbers: parseNumbers(process.env.GV_AUTHORIZED_NUMBERS),
    authorizedNames: parseNumbers(process.env.GV_AUTHORIZED_NAMES),
    headless: (process.env.GV_HEADLESS || 'true').toLowerCase() === 'true',
    displayNum: process.env.GV_DISPLAY_NUM || ':99',
    autoAccept: (process.env.GV_AUTO_ACCEPT || 'true').toLowerCase() === 'true',
    pollInterval: parseInt(process.env.GV_POLL_INTERVAL || '1000', 10),
    extraArgs: process.env.GV_CHROMIUM_ARGS ? process.env.GV_CHROMIUM_ARGS.split(',') : undefined,
    logLevel: (process.env.GV_LOG_LEVEL || 'info') as LogLevel,
  };
}

export function validateConfig(config: BridgeConfig): void {
  if (config.authorizedNumbers.length === 0 && (!config.authorizedNames || config.authorizedNames.length === 0)) {
    console.warn(
      '[WARN] No authorized numbers configured. Set GV_AUTHORIZED_NUMBERS env var.'
    );
  }

  if (!fs.existsSync(config.defaultProfilePath)) {
    console.warn(
      `[WARN] Chromium profile not found at ${config.defaultProfilePath}. ` +
        'Browsers will start without persistent profile.'
    );
  }
}
