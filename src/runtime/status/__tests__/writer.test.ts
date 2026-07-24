/**
 * StatusFileWriter tests — verifies the JSON contract consumed by
 * `voicebridge status <instance-id>`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StatusFileWriter, type StatusFileContents } from '../writer';
import type { BridgeStatus } from '../../../types';

function makeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    running: true,
    audioReady: true,
    voiceBrowserReady: true,
    aiBrowserReady: true,
    voiceLoggedIn: true,
    aiLoggedIn: true,
    inCall: false,
    voiceModeActive: false,
    aiVoiceUnavailable: false,
    voicePageResponsive: true,
    aiPageResponsive: true,
    ...overrides,
  };
}

describe('StatusFileWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-status-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes status and critical issues as JSON', () => {
    const file = path.join(tmpDir, 'status.json');
    const writer = new StatusFileWriter(file);

    writer.write(makeStatus({ aiVoiceUnavailable: true, aiVoiceStatusDetail: 'out of credits' }), [
      'ai_voice_unavailable: out of credits',
    ]);

    const data: StatusFileContents = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.status.running).toBe(true);
    expect(data.status.aiVoiceUnavailable).toBe(true);
    expect(data.criticalIssues).toEqual(['ai_voice_unavailable: out of credits']);
    expect(new Date(data.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('creates the parent directory when missing', () => {
    const file = path.join(tmpDir, 'nested', 'dir', 'status.json');
    const writer = new StatusFileWriter(file);

    writer.write(makeStatus());

    expect(fs.existsSync(file)).toBe(true);
  });

  it('defaults criticalIssues to an empty array', () => {
    const file = path.join(tmpDir, 'status.json');
    const writer = new StatusFileWriter(file);

    writer.write(makeStatus());

    const data: StatusFileContents = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.criticalIssues).toEqual([]);
  });

  it('silently ignores write errors', () => {
    // Parent path is a regular file → mkdirSync fails fast with ENOTDIR.
    // (Do NOT use /proc for this — recursive mkdirSync spins forever there on Node 22.)
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const writer = new StatusFileWriter(path.join(blocker, 'child', 'status.json'));
    expect(() => writer.write(makeStatus())).not.toThrow();
  });
});
