/**
 * XvfbManager — manages Xvfb virtual display lifecycle
 * Extracted from BridgeOrchestrator for testability.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { Logger } from '../logger';

export class XvfbManager {
  private process: ChildProcess | null = null;

  constructor(private logger: Logger) {}

  async start(displayNum: string): Promise<void> {
    const num = displayNum.replace(':', '');
    this.logger.info(`Starting Xvfb on display :${num}`);

    this.process = spawn(
      'Xvfb',
      [`:${num}`, '-screen', '0', '1280x720x24', '-ac', '+extension', 'GLX', '+render', '-noreset'],
      { detached: false, stdio: 'ignore' },
    );

    this.process.on('error', (err) => {
      this.logger.error('Xvfb process error', { error: err.message });
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    this.logger.info(`Xvfb started on display :${num}`);
  }

  stop(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        this.logger.debug('Xvfb process terminated');
      } catch (err) {
        this.logger.warn('Error killing Xvfb', { error: (err as Error).message });
      }
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
