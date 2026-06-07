/**
 * systemd user service template generator.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getInstanceServicePath, getInstanceConfigPath, getInstanceDataDir, getInstanceLogPath } from '../../instance/paths';

export function generateServiceFile(instanceId: string): string {
  const configPath = getInstanceConfigPath(instanceId);
  const dataDir = getInstanceDataDir(instanceId);
  const logPath = getInstanceLogPath(instanceId);

  return `[Unit]
Description=GV Bridge Instance: ${instanceId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${dataDir}
Environment="HOME=%h"
Environment="USER=%u"
Environment="XDG_RUNTIME_DIR=/run/user/%U"
Environment="GV_BRIDGE_INSTANCE=${instanceId}"
Environment="GV_BRIDGE_CONFIG=${configPath}"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
ExecStartPre=-/usr/bin/bash -c "/usr/bin/pkill -9 -f 'chromium' 2>/dev/null || true"
ExecStart=/usr/local/bin/voicebridge-run
Restart=on-failure
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export function writeServiceFile(instanceId: string): string {
  const servicePath = getInstanceServicePath(instanceId);
  const dir = path.dirname(servicePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = generateServiceFile(instanceId);
  fs.writeFileSync(servicePath, content, 'utf-8');
  return servicePath;
}

export function removeServiceFile(instanceId: string): boolean {
  const servicePath = getInstanceServicePath(instanceId);
  if (!fs.existsSync(servicePath)) return false;
  fs.unlinkSync(servicePath);
  return true;
}

export function getServiceName(instanceId: string): string {
  return `gv-bridge-${instanceId}.service`;
}
