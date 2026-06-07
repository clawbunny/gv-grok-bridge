/**
 * voicebridge start — start an instance via systemd --user.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function startCommand(): Command {
  return new Command('start')
    .description('Start an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge start martin-gv-grok-01
  voicebridge start work-bridge

Note:
  You must be logged in to your voice and AI providers in Chromium first,
  and close the browser so the profile is not locked.
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user start ${service}`, { stdio: 'inherit' });
        console.log(`Instance "${instanceId}" started.`);
      } catch {
        process.exit(1);
      }
    });
}
