/**
 * voicebridge status — show systemd status and bridge internal state for one instance.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';
import { getInstanceStatusPath, getInstanceConfigPath } from '../../instance/paths';
import type { BridgeStatus } from '../../types';

interface StatusFileContents {
  timestamp: string;
  status: BridgeStatus;
  criticalIssues: string[];
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Show systemd status and bridge internal state for an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge status martin-gv-grok-01
  voicebridge status work-bridge

Exit codes:
  0  — Service is active and no critical issues detected
  1  — Service is inactive, not found, or critical issues detected
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      let systemdActive = false;

      // Show systemd status
      try {
        execSync(`systemctl --user status ${service}`, { stdio: 'inherit' });
        systemdActive = true;
      } catch {
        console.error(`\n[Systemd] Service ${service} is not active.`);
        systemdActive = false;
      }

      // Read and display bridge internal state
      const statusPath = getInstanceStatusPath(instanceId);
      const configPath = getInstanceConfigPath(instanceId);
      let hasCriticalIssues = false;

      if (fs.existsSync(statusPath)) {
        try {
          const raw = fs.readFileSync(statusPath, 'utf-8');
          const data: StatusFileContents = JSON.parse(raw);

          console.log('\n┌─────────────────────────────────────────────────────────────┐');
          console.log('│  Bridge Internal State                                      │');
          console.log('└─────────────────────────────────────────────────────────────┘');
          console.log(`  Last Update:     ${data.timestamp}`);
          console.log(`  Running:         ${fmtBool(data.status.running)}`);
          console.log(`  Audio Ready:     ${fmtBool(data.status.audioReady)}`);
          console.log(`  Voice Browser:   ${fmtBool(data.status.voiceBrowserReady)}`);
          console.log(`  AI Browser:      ${fmtBool(data.status.aiBrowserReady)}`);
          console.log(`  Voice Logged In: ${fmtBool(data.status.voiceLoggedIn)}`);
          console.log(`  AI Logged In:    ${fmtBool(data.status.aiLoggedIn)}`);
          console.log(`  In Call:         ${fmtBool(data.status.inCall)}`);
          console.log(`  Voice Mode:      ${fmtBool(data.status.voiceModeActive)}`);

          if (data.criticalIssues.length > 0) {
            hasCriticalIssues = true;
            console.log('\n┌─────────────────────────────────────────────────────────────┐');
            console.log('│  ⚠️  CRITICAL ISSUES DETECTED                              │');
            console.log('└─────────────────────────────────────────────────────────────┘');
            for (const issue of data.criticalIssues) {
              console.log(`  • ${issue}`);
            }
            console.log('\n  These issues will prevent the bridge from working correctly.');
            console.log('  They will NOT auto-recover without user intervention.\n');
          }
        } catch (err) {
          console.warn(`\n[Status] Could not parse status file: ${(err as Error).message}`);
        }
      } else {
        console.log('\n[Status] No status file found. The bridge may not have finished starting.');
      }

      // Show alert email config
      if (fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (cfg.alertEmail) {
            console.log(`  Alert Email:     ${cfg.alertEmail}`);
          }
        } catch {
          // ignore
        }
      }

      if (!systemdActive || hasCriticalIssues) {
        process.exit(1);
      }
    });
}

function fmtBool(value: boolean): string {
  return value ? '\x1b[32m✓ yes\x1b[0m' : '\x1b[31m✗ no \x1b[0m';
}
