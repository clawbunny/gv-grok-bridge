/**
 * voicebridge stop — stop an instance via systemd --user.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function stopCommand(): Command {
  return new Command('stop')
    .description('Stop an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge stop martin-gv-grok-01
  voicebridge stop work-bridge
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user stop ${service}`, { stdio: 'inherit' });
        console.log(`Instance "${instanceId}" stopped.`);
      } catch {
        process.exit(1);
      }
    });
}
