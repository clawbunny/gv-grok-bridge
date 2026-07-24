/**
 * Instance registry tests — discovered behavior of src/instance/registry.ts
 *
 * These tests document the YAML-based CRUD operations for instance configs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  listInstances,
  loadInstance,
  saveInstance,
  deleteInstance,
  instanceExists,
} from '../registry';
import type { InstanceConfig } from '../config';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: jest.fn(),
  };
});

const mockedHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gv-bridge-registry-test-'));
  mockedHomedir.mockReturnValue(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  jest.clearAllMocks();
});

function createConfig(instanceId: string): InstanceConfig {
  return {
    instanceId,
    voiceProvider: { type: 'google-voice' },
    aiProvider: { type: 'grok' },
    authorizedNumbers: ['+14085506532'],
    authorizedNames: [],
    headless: true,
    autoAccept: true,
    pollInterval: 1000,
    logLevel: 'info',
    profilePath: '/home/user/.config/chromium',
  };
}

describe('Instance registry', () => {
  it('lists no instances initially', () => {
    expect(listInstances()).toEqual([]);
  });

  it('saves and loads an instance', () => {
    const config = createConfig('test-instance');
    saveInstance(config);

    expect(listInstances()).toEqual(['test-instance']);

    const loaded = loadInstance('test-instance');
    expect(loaded).toMatchObject({
      instanceId: 'test-instance',
      voiceProvider: { type: 'google-voice' },
      aiProvider: { type: 'grok' },
      authorizedNumbers: ['+14085506532'],
    });
  });

  it('returns null for a non-existent instance', () => {
    expect(loadInstance('does-not-exist')).toBeNull();
  });

  it('reports instance existence correctly', () => {
    const config = createConfig('existing-instance');
    saveInstance(config);

    expect(instanceExists('existing-instance')).toBe(true);
    expect(instanceExists('missing-instance')).toBe(false);
  });

  it('deletes an instance', () => {
    const config = createConfig('to-delete');
    saveInstance(config);
    expect(instanceExists('to-delete')).toBe(true);

    const result = deleteInstance('to-delete');
    expect(result).toBe(true);
    expect(instanceExists('to-delete')).toBe(false);
    expect(loadInstance('to-delete')).toBeNull();
  });

  it('returns false when deleting a non-existent instance', () => {
    expect(deleteInstance('never-existed')).toBe(false);
  });

  it('sorts instance names alphabetically', () => {
    saveInstance(createConfig('zebra'));
    saveInstance(createConfig('alpha'));
    saveInstance(createConfig('mike'));

    expect(listInstances()).toEqual(['alpha', 'mike', 'zebra']);
  });
});
