/**
 * Status Command Tests — strict TDD.
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import { instanceExists } from '../../../instance/registry';
import { getServiceName } from '../../systemd/template';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../../../instance/registry');
jest.mock('../../systemd/template');

const mockedFs = jest.mocked(fs);
const mockedExecSync = jest.mocked(execSync);
const mockedInstanceExists = jest.mocked(instanceExists);
const mockedGetServiceName = jest.mocked(getServiceName);

import { statusCommand } from '../status';

describe('statusCommand', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    mockedInstanceExists.mockReturnValue(true);
    mockedGetServiceName.mockReturnValue('gv-bridge-test.service');
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('is-active')) return Buffer.from('active\n');
      if (cmd.includes('is-enabled')) return Buffer.from('enabled\n');
      if (cmd.includes('status')) {
        // Simulate systemd status output without actually running it
        return Buffer.from('');
      }
      throw new Error('unknown command');
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  function createStatusJson(status: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      status,
      criticalIssues: [],
    });
  }

  it('shows systemd status when no status.json exists', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const cmd = statusCommand();
    await cmd.parseAsync(['node', 'voicebridge', 'status', 'test']);

    expect(mockedExecSync).toHaveBeenCalledWith('systemctl --user status gv-bridge-test.service', expect.anything());
  });

  it('shows critical issues when status.json exists with failures', async () => {
    const status = {
      running: true,
      audioReady: true,
      voiceBrowserReady: true,
      aiBrowserReady: true,
      voiceLoggedIn: false,
      aiLoggedIn: true,
      inCall: false,
      voiceModeActive: false,
    };

    mockedFs.existsSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      return typeof path === 'string' && path.includes('status.json');
    });
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        status,
        criticalIssues: ['voice_not_logged_in'],
      }),
    );

    const cmd = statusCommand();
    await cmd.parseAsync(['node', 'voicebridge', 'status', 'test']);

    const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('CRITICAL');
    expect(logs).toContain('voice_not_logged_in');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 0 when status is healthy', async () => {
    mockedFs.existsSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      return typeof path === 'string' && path.includes('status.json');
    });
    mockedFs.readFileSync.mockReturnValue(
      createStatusJson({
        running: true,
        audioReady: true,
        voiceBrowserReady: true,
        aiBrowserReady: true,
        voiceLoggedIn: true,
        aiLoggedIn: true,
        inCall: false,
        voiceModeActive: false,
      }),
    );

    const cmd = statusCommand();
    await cmd.parseAsync(['node', 'voicebridge', 'status', 'test']);

    expect(processExitSpy).not.toHaveBeenCalledWith(1);
  });

  it('shows alert email config when present', async () => {
    mockedFs.existsSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      if (typeof path === 'string' && path.includes('status.json')) return true;
      if (typeof path === 'string' && path.includes('.yaml')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      if (typeof path === 'string' && path.includes('status.json')) {
        return createStatusJson({
          running: true,
          audioReady: true,
          voiceBrowserReady: true,
          aiBrowserReady: true,
          voiceLoggedIn: true,
          aiLoggedIn: true,
        });
      }
      if (typeof path === 'string' && path.includes('.yaml')) {
        return 'alertEmail: admin@example.com\n';
      }
      return '';
    });

    const cmd = statusCommand();
    await cmd.parseAsync(['node', 'voicebridge', 'status', 'test']);

    const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('admin@example.com');
  });

  it('falls back to systemd status if status.json is corrupted', async () => {
    mockedFs.existsSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      return typeof path === 'string' && path.includes('status.json');
    });
    mockedFs.readFileSync.mockReturnValue('not valid json {{{');

    const cmd = statusCommand();
    await cmd.parseAsync(['node', 'voicebridge', 'status', 'test']);

    expect(mockedExecSync).toHaveBeenCalledWith('systemctl --user status gv-bridge-test.service', expect.anything());
  });
});
