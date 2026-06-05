#!/usr/bin/env node
/**
 * Entry point — GV-Grok Bridge
 *
 * Wires all modules together via dependency injection and starts the bridge.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig, validateConfig } from './config';
import { ConsoleLogger } from './logger';
import { AudioPipeline } from './audio/pipeline';
import { BrowserManager, createBrowserLauncher } from './browser/manager';
import { VoiceMonitor } from './voice/monitor';
import { GrokController } from './grok/controller';
import { XvfbManager } from './bridge/xvfb';
import { BridgeOrchestrator } from './bridge/orchestrator';

const execAsync = promisify(exec);

async function main(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);

  const logger = new ConsoleLogger('Bridge', config.logLevel);

  // ── Wire dependencies ──────────────────────────────
  const audioPipeline = new AudioPipeline(
    (cmd: string) => execAsync(cmd),
    logger,
  );

  const browserManager = new BrowserManager(
    createBrowserLauncher(config.headless, config.extraArgs),
    logger,
  );

  const voiceMonitor = new VoiceMonitor(logger);
  const grokController = new GrokController(logger);
  const xvfbManager = new XvfbManager(logger);

  const bridge = new BridgeOrchestrator(
    config,
    audioPipeline,
    browserManager,
    voiceMonitor,
    grokController,
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
