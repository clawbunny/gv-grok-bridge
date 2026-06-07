/**
 * Per-instance path utilities.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function getInstanceConfigDir(): string {
  return path.join(os.homedir(), '.config', 'gv-bridge');
}

export function getInstanceDataDir(instanceId: string): string {
  return path.join(os.homedir(), '.local', 'share', 'gv-bridge', 'instances', instanceId);
}

export function getInstanceLogDir(instanceId: string): string {
  return path.join(os.homedir(), '.local', 'state', 'gv-bridge', 'instances', instanceId);
}

export function getInstanceConfigPath(instanceId: string): string {
  return path.join(getInstanceConfigDir(), 'instances', `${instanceId}.yaml`);
}

export function getInstanceTempProfilePath(instanceId: string): string {
  return path.join(os.tmpdir(), 'gv-bridge', instanceId, 'chromium-copy');
}

export function getInstanceLogPath(instanceId: string): string {
  return path.join(getInstanceLogDir(instanceId), 'bridge.log');
}

export function getInstanceServicePath(instanceId: string): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `gv-bridge-${instanceId}.service`);
}

export function getDisplayPoolPath(): string {
  return path.join(getInstanceConfigDir(), 'displays.yaml');
}

/**
 * Sanitize instanceId into a PulseAudio-safe namespace.
 * PulseAudio device names allow [a-zA-Z0-9_-].
 */
export function getAudioNamespace(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Ensure all directories for an instance exist. */
export function ensureInstanceDirs(instanceId: string): void {
  const dirs = [
    path.join(getInstanceConfigDir(), 'instances'),
    getInstanceDataDir(instanceId),
    getInstanceLogDir(instanceId),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
