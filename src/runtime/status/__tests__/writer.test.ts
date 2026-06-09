/**
 * StatusFileWriter Tests — strict TDD.
 */

import { StatusFileWriter } from '../writer';
import type { BridgeStatus } from '../../../types';

describe('StatusFileWriter', () => {
  let writer: StatusFileWriter;
  let writtenFiles: Map<string, string>;
  let mockMkdirSync: jest.Mock;

  beforeEach(() => {
    writtenFiles = new Map();
    mockMkdirSync = jest.fn();

    writer = new StatusFileWriter(
      '/tmp/test-status/status.json',
      {
        existsSync: jest.fn().mockReturnValue(false),
        writeFileSync: jest.fn().mockImplementation((path: string, data: string) => {
          writtenFiles.set(path, data);
        }),
        mkdirSync: mockMkdirSync,
      } as any,
    );
  });

  function createStatus(): BridgeStatus {
    return {
      running: true,
      audioReady: true,
      voiceBrowserReady: true,
      aiBrowserReady: true,
      voiceLoggedIn: true,
      aiLoggedIn: true,
      inCall: false,
      voiceModeActive: false,
    };
  }

  it('writes status to file', () => {
    const status = createStatus();
    writer.write(status);

    expect(writtenFiles.has('/tmp/test-status/status.json')).toBe(true);
    const data = JSON.parse(writtenFiles.get('/tmp/test-status/status.json')!);
    expect(data.status.running).toBe(true);
  });

  it('includes ISO timestamp', () => {
    const before = new Date().toISOString();
    writer.write(createStatus());
    const after = new Date().toISOString();

    const data = JSON.parse(writtenFiles.get('/tmp/test-status/status.json')!);
    expect(data.timestamp >= before && data.timestamp <= after).toBe(true);
  });

  it('creates parent directory if missing', () => {
    writer.write(createStatus());
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-status', { recursive: true });
  });

  it('gracefully handles write errors', () => {
    const errorWriter = new StatusFileWriter(
      '/tmp/test-status/status.json',
      {
        existsSync: jest.fn().mockReturnValue(false),
        writeFileSync: jest.fn().mockImplementation(() => {
          throw new Error('Disk full');
        }),
        mkdirSync: jest.fn(),
      } as any,
    );

    expect(() => errorWriter.write(createStatus())).not.toThrow();
  });
});
