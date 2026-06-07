/**
 * voicebridge destroy — remove an instance and its systemd service.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { instanceExists, listInstances } from '../../instance/registry';
import { getInstanceConfigPath, getInstanceLogPath, getInstanceDataDir, getInstanceServicePath } from '../../instance/paths';
import { getServiceName } from '../systemd/template';
import { freeDisplay } from '../../instance/display-pool';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function destroyCommand(): Command {
  return new Command('destroy')
    .description('Remove an instance and its systemd service')
    .argument('<instance-id>', 'Instance identifier')
    .option('--yes', 'Skip confirmation')
    .addHelpText('after', `
Examples:
  voicebridge destroy martin-gv-grok-01
  voicebridge destroy martin-gv-grok-01 --yes    # No confirmation prompt

Warning:
  This permanently removes the instance config, service, logs, and display allocation.
  Instance data is NOT removed from Chromium's profile.
`)
    .action(async (instanceId: string, options) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      if (!options.yes) {
        const confirm = await ask(`Are you sure you want to destroy instance "${instanceId}"? [y/N]: `);
        if (confirm.toLowerCase() !== 'y') {
          console.log('Cancelled.');
          return;
        }
      }

      const service = getServiceName(instanceId);

      // Stop and disable
      try { execSync(`systemctl --user stop ${service}`, { stdio: 'ignore' }); } catch { /* ignore */ }
      try { execSync(`systemctl --user disable ${service}`, { stdio: 'ignore' }); } catch { /* ignore */ }

      // Remove files
      const configPath = getInstanceConfigPath(instanceId);
      const logPath = getInstanceLogPath(instanceId);
      const instanceDir = getInstanceDataDir(instanceId);
      const servicePath = getInstanceServicePath(instanceId);

      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
      if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      if (fs.existsSync(instanceDir)) fs.rmSync(instanceDir, { recursive: true, force: true });

      // Free display
      freeDisplay(instanceId);

      // Reload systemd
      try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      } catch { /* ignore */ }

      console.log(`Instance "${instanceId}" destroyed.`);
      if (listInstances().length === 0) {
        console.log('No instances remain. Run "voicebridge setup" to create a new one.');
      }
    });
}
