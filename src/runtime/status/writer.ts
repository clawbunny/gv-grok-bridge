/**
 * StatusFileWriter — periodically writes bridge status to a JSON file
 * so that CLI commands can inspect runtime state without IPC.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BridgeStatus } from '../../types';

export interface StatusFileContents {
  timestamp: string;
  status: BridgeStatus;
  criticalIssues: string[];
}

export class StatusFileWriter {
  constructor(
    private filePath: string,
    private fsImpl: typeof fs = fs,
  ) {}

  /** Write current bridge status to disk. Silently fails on error. */
  write(status: BridgeStatus, criticalIssues: string[] = []): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!this.fsImpl.existsSync(dir)) {
        this.fsImpl.mkdirSync(dir, { recursive: true });
      }
      const contents: StatusFileContents = {
        timestamp: new Date().toISOString(),
        status: { ...status },
        criticalIssues: [...criticalIssues],
      };
      this.fsImpl.writeFileSync(this.filePath, JSON.stringify(contents, null, 2));
    } catch {
      // Silently ignore write errors to avoid disrupting the bridge
    }
  }
}
