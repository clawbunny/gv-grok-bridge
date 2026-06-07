/**
 * voicebridge list — show all instances and their systemd status.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Command } from 'commander';
import { execSync } from 'child_process';
import { listInstances } from '../../instance/registry';
import { getInstanceConfigPath } from '../../instance/paths';
import { getServiceName } from '../systemd/template';

export function listCommand(): Command {
  return new Command('list')
    .description('List all bridge instances and their status')
    .addHelpText('after', `
Example:
  voicebridge list

Output columns:
  Status   — active / inactive (from systemd --user)
  Enabled  — enabled / disabled (auto-start on boot)
  Display  — Xvfb display number assigned to this instance
`)
    .action(() => {
      const instances = listInstances();
      if (instances.length === 0) {
        console.log('No instances found.');
        console.log('Run "voicebridge setup" to create one.');
        console.log('');
        console.log('Prerequisite: log in to your providers in Chromium,');
        console.log('then close the browser before starting the bridge.');
        return;
      }

      console.log('\nInstance ID              Status     Enabled    Display');
      console.log('─────────────────────────────────────────────────────────');

      for (const id of instances) {
        const service = getServiceName(id);
        let status = 'unknown';
        let enabled = 'unknown';
        let display = '-';

        try {
          const out = execSync(`systemctl --user is-active ${service}`, { encoding: 'utf-8', stdio: 'pipe' });
          status = out.trim();
        } catch {
          status = 'inactive';
        }

        try {
          const out = execSync(`systemctl --user is-enabled ${service}`, { encoding: 'utf-8', stdio: 'pipe' });
          enabled = out.trim();
        } catch {
          enabled = 'disabled';
        }

        try {
          const configPath = getInstanceConfigPath(id);
          if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const cfg = yaml.load(raw) as Record<string, unknown>;
            display = (cfg.displayNum as string) || '-';
          }
        } catch {
          // ignore
        }

        const statusColor = status === 'active' ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';
        console.log(`${id.padEnd(24)} ${statusColor}${status.padEnd(10)}${reset} ${enabled.padEnd(10)} ${display}`);
      }
      console.log('');
    });
}
