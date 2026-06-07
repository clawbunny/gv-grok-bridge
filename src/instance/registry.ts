/**
 * Instance registry — CRUD for instance YAML configs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { InstanceConfig } from './config';
import { getInstanceConfigDir, getInstanceConfigPath, ensureInstanceDirs } from './paths';

export interface InstanceRecord {
  config: InstanceConfig;
  createdAt: string;
  updatedAt: string;
}

function getRegistryDir(): string {
  return path.join(getInstanceConfigDir(), 'instances');
}

function ensureRegistryDir(): void {
  const dir = getRegistryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function listInstances(): string[] {
  ensureRegistryDir();
  const dir = getRegistryDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

export function loadInstance(instanceId: string): InstanceConfig | null {
  const configPath = getInstanceConfigPath(instanceId);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return yaml.load(raw) as InstanceConfig;
  } catch {
    return null;
  }
}

export function saveInstance(config: InstanceConfig): void {
  ensureInstanceDirs(config.instanceId);
  const configPath = getInstanceConfigPath(config.instanceId);
  const record: InstanceRecord = {
    config,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, yaml.dump(record.config, { lineWidth: -1 }), 'utf-8');
}

export function deleteInstance(instanceId: string): boolean {
  const configPath = getInstanceConfigPath(instanceId);
  if (!fs.existsSync(configPath)) return false;
  fs.unlinkSync(configPath);
  return true;
}

export function instanceExists(instanceId: string): boolean {
  return fs.existsSync(getInstanceConfigPath(instanceId));
}
