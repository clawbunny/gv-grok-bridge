/**
 * AlertManager Tests — strict TDD.
 */

import { AlertManager } from '../manager';
import type { BridgeStatus } from '../../../types';
import { SilentLogger } from '../../../logger';

describe('AlertManager', () => {
  let manager: AlertManager;
  let execCalls: string[];
  let mockExec: jest.Mock;
  let writtenFiles: Map<string, string>;
  let mockSendmailPath: string | null;

  beforeEach(() => {
    execCalls = [];
    writtenFiles = new Map();
    mockSendmailPath = '/usr/sbin/sendmail';

    mockExec = jest.fn().mockImplementation((cmd: string, _opts: any, cb: Function) => {
      execCalls.push(cmd);
      const child = {
        stdin: {
          _data: '',
          write(data: string) { this._data += data; },
          end() { execCalls.push(this._data); },
        },
      };
      // Simulate async exec completion
      setTimeout(() => cb(null, { stdout: '', stderr: '' }), 0);
      return child;
    });

    manager = new AlertManager(
      { instanceId: 'test-instance', logDir: '/tmp/test-alerts' },
      new SilentLogger(),
      {
        existsSync: jest.fn().mockReturnValue(true),
        readFileSync: jest.fn().mockImplementation((path: string) => {
          if (writtenFiles.has(path)) return writtenFiles.get(path);
          throw new Error('ENOENT');
        }),
        writeFileSync: jest.fn().mockImplementation((path: string, data: string) => {
          writtenFiles.set(path, data);
        }),
        mkdirSync: jest.fn(),
      } as any,
      {
        exec: mockExec,
      } as any,
      () => mockSendmailPath,
    );
  });

  function createStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
    return {
      running: true,
      audioReady: true,
      voiceBrowserReady: true,
      aiBrowserReady: true,
      voiceLoggedIn: true,
      aiLoggedIn: true,
      inCall: false,
      voiceModeActive: false,
      ...overrides,
    };
  }

  describe('detectCriticalIssues', () => {
    it('returns empty array when all systems healthy', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus());
      expect(issues).toEqual([]);
    });

    it('detects voice_not_logged_in', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ voiceLoggedIn: false }));
      expect(issues).toContain('voice_not_logged_in');
    });

    it('detects ai_not_logged_in', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ aiLoggedIn: false }));
      expect(issues).toContain('ai_not_logged_in');
    });

    it('detects voice_browser_not_ready', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ voiceBrowserReady: false }));
      expect(issues).toContain('voice_browser_not_ready');
    });

    it('detects ai_browser_not_ready', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ aiBrowserReady: false }));
      expect(issues).toContain('ai_browser_not_ready');
    });

    it('detects audio_not_ready', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ audioReady: false }));
      expect(issues).toContain('audio_not_ready');
    });

    it('detects not_running', () => {
      const issues = (manager as any).detectCriticalIssues(createStatus({ running: false }));
      expect(issues).toContain('not_running');
    });

    it('returns multiple issues when multiple systems fail', () => {
      const issues = (manager as any).detectCriticalIssues(
        createStatus({ voiceLoggedIn: false, aiLoggedIn: false, audioReady: false }),
      );
      expect(issues).toHaveLength(3);
      expect(issues).toContain('voice_not_logged_in');
      expect(issues).toContain('ai_not_logged_in');
      expect(issues).toContain('audio_not_ready');
    });
  });

  describe('checkAndAlert', () => {
    it('does nothing when no critical issues', () => {
      manager.checkAndAlert(createStatus(), 'test@example.com');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('does nothing when alertEmail is not configured', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), undefined);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('sends email when critical issue detected', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalled();
      const cmd = execCalls[0];
      expect(cmd).toContain('/usr/sbin/sendmail');
      expect(cmd).toContain('admin@example.com');
    });

    it('email subject contains instance id and issue', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      // execCalls[0] is the command, execCalls[1] is the stdin body
      const body = execCalls[1];
      expect(body).toMatch(/Subject:.*test-instance.*voice_not_logged_in/i);
    });

    it('email body contains current status', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      const body = execCalls[1];
      expect(body).toContain('Running: true');
      expect(body).toContain('Voice Logged In: false');
    });

    it('rate-limits duplicate alerts', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Second call immediately should not send another email
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('sends alert again after cooldown expires', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Simulate cooldown passed by manipulating last alert time
      const statePath = '/tmp/test-alerts/test-instance-alerts.json';
      const state = JSON.parse(writtenFiles.get(statePath) || '{}');
      state.voice_not_logged_in = Date.now() - 61 * 60 * 1000; // 61 minutes ago
      writtenFiles.set(statePath, JSON.stringify(state));

      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('sends alert for new issue type even during cooldown for another', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(1);

      manager.checkAndAlert(createStatus({ aiLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('resets alert cooldown when issue is resolved', () => {
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Issue resolved
      manager.checkAndAlert(createStatus({ voiceLoggedIn: true }), 'admin@example.com');

      // Issue returns immediately — should alert because cooldown was reset
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('logs warning when sendmail is not available', () => {
      mockSendmailPath = null;
      manager.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('creates alert state directory if missing', () => {
      const mkdirMock = jest.fn();
      const m = new AlertManager(
        { instanceId: 'test-instance', logDir: '/tmp/test-alerts' },
        new SilentLogger(),
        {
          existsSync: jest.fn().mockReturnValue(false),
          readFileSync: jest.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
          writeFileSync: jest.fn(),
          mkdirSync: mkdirMock,
        } as any,
        { exec: mockExec } as any,
        () => '/usr/sbin/sendmail',
      );
      m.checkAndAlert(createStatus({ voiceLoggedIn: false }), 'admin@example.com');
      expect(mkdirMock).toHaveBeenCalledWith('/tmp/test-alerts', { recursive: true });
    });
  });

  describe('issue descriptions', () => {
    it('has human-readable descriptions for all issue types', () => {
      const descMap = (manager as any).issueDescriptions;
      expect(descMap.voice_not_logged_in).toBeTruthy();
      expect(descMap.ai_not_logged_in).toBeTruthy();
      expect(descMap.voice_browser_not_ready).toBeTruthy();
      expect(descMap.ai_browser_not_ready).toBeTruthy();
      expect(descMap.audio_not_ready).toBeTruthy();
      expect(descMap.not_running).toBeTruthy();
    });
  });
});
