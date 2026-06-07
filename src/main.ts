#!/usr/bin/env node
/**
 * Entry point — GV Bridge single-instance runner.
 *
 * Reads GV_BRIDGE_CONFIG (or GV_BRIDGE_INSTANCE) env var to determine
 * which instance to run, then wires all modules via dependency injection.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { ConsoleLogger } from './logger';
import { AudioPipeline } from './runtime/audio/pipeline';
import { BrowserManager, createBrowserLauncher } from './runtime/browser/manager';
import { VoiceMonitor } from './runtime/monitor';
import { AIController } from './runtime/ai-controller';
import { XvfbManager } from './runtime/xvfb';
import { BridgeOrchestrator } from './runtime/orchestrator';
import { getVoiceProvider, getAIProvider } from './providers';
import { loadInstance } from './instance/registry';
import { instanceConfigToBridgeConfig, type InstanceConfig } from './instance/config';
import { getInstanceConfigPath } from './instance/paths';

const execAsync = promisify(exec);

function resolveInstanceConfig(): { config: import('./types').BridgeConfig; instanceId: string } | null {
  const instanceId = process.env.GV_BRIDGE_INSTANCE;
  const configPath = process.env.GV_BRIDGE_CONFIG;

  if (configPath) {
    if (!fs.existsSync(configPath)) {
      console.error(`[ERROR] Config file not found: ${configPath}`);
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const instanceConfig = yaml.load(raw) as InstanceConfig;
    return { config: instanceConfigToBridgeConfig(instanceConfig), instanceId: instanceConfig.instanceId };
  }

  if (instanceId) {
    const instanceConfig = loadInstance(instanceId);
    if (!instanceConfig) {
      console.error(`[ERROR] Instance not found: ${instanceId}`);
      return null;
    }
    return { config: instanceConfigToBridgeConfig(instanceConfig), instanceId };
  }

  // Fallback: legacy single-instance mode using env vars directly
  console.warn('[WARN] No GV_BRIDGE_INSTANCE or GV_BRIDGE_CONFIG set. Falling back to legacy env-var mode.');
  const legacyConfig = loadLegacyConfig();
  return { config: legacyConfig, instanceId: legacyConfig.instanceId };
}

function loadLegacyConfig(): import('./types').BridgeConfig {
  const DEFAULT_PROFILE = path.join(os.homedir(), '.config', 'chromium');
  const TEMP_PROFILE = path.join(os.tmpdir(), 'gv-grok-bridge', 'chromium-copy');

  function parseNumbers(input?: string): string[] {
    if (!input) return [];
    return input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  const logLevel = (process.env.GV_LOG_LEVEL || 'info') as import('./logger').LogLevel;

  return {
    instanceId: 'legacy',
    namespace: 'legacy',
    defaultProfilePath: process.env.GV_PROFILE_PATH || DEFAULT_PROFILE,
    tempProfilePath: TEMP_PROFILE,
    authorizedNumbers: parseNumbers(process.env.GV_AUTHORIZED_NUMBERS),
    authorizedNames: parseNumbers(process.env.GV_AUTHORIZED_NAMES),
    headless: (process.env.GV_HEADLESS || 'true').toLowerCase() === 'true',
    displayNum: process.env.GV_DISPLAY_NUM || ':99',
    autoAccept: (process.env.GV_AUTO_ACCEPT || 'true').toLowerCase() === 'true',
    pollInterval: parseInt(process.env.GV_POLL_INTERVAL || '1000', 10),
    extraArgs: process.env.GV_CHROMIUM_ARGS ? process.env.GV_CHROMIUM_ARGS.split(',') : undefined,
    logLevel,
    voiceProvider: { type: process.env.GV_VOICE_PROVIDER || 'google-voice' },
    aiProvider: { type: process.env.GV_AI_PROVIDER || 'grok' },
  };
}

async function main(): Promise<void> {
  const resolved = resolveInstanceConfig();
  if (!resolved) {
    console.error('[ERROR] Could not resolve instance configuration.');
    console.error('       Set GV_BRIDGE_INSTANCE=<id> or GV_BRIDGE_CONFIG=/path/to/config.yaml');
    process.exit(1);
  }

  const { config, instanceId } = resolved;
  const logger = new ConsoleLogger(instanceId, config.logLevel);

  let voiceProvider;
  let aiProvider;
  try {
    voiceProvider = getVoiceProvider(config.voiceProvider.type);
    aiProvider = getAIProvider(config.aiProvider.type);
  } catch (err) {
    logger.error('Failed to resolve providers', { error: (err as Error).message });
    process.exit(1);
  }

  // ── Wire dependencies ──────────────────────────────
  const audioPipeline = new AudioPipeline(
    config.namespace,
    (cmd: string) => execAsync(cmd),
    logger,
  );

  const browserManager = new BrowserManager(
    createBrowserLauncher(config.headless, config.extraArgs),
    logger,
  );

  const voiceMonitor = new VoiceMonitor(logger);
  const aiController = new AIController(logger);
  const xvfbManager = new XvfbManager(logger);

  const bridge = new BridgeOrchestrator(
    config,
    audioPipeline,
    browserManager,
    voiceMonitor,
    aiController,
    voiceProvider,
    aiProvider,
    xvfbManager,
    logger,
  );

  // ── Graceful shutdown ──────────────────────────────
  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  // ── Start ──────────────────────────────────────────
  try {
    await bridge.start();
  } catch (err) {
    logger.error('Failed to start bridge', { error: (err as Error).message });
    await bridge.stop();
    process.exit(1);
  }
}

main();
