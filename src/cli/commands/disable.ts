/**
 * voicebridge disable — disable auto-start on boot for an instance.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function disableCommand(): Command {
  return new Command('disable')
    .description('Disable auto-start on boot for an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge disable martin-gv-grok-01
  voicebridge disable work-bridge
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user disable ${service}`, { stdio: 'inherit' });
        console.log(`Instance "${instanceId}" disabled.`);
      } catch {
        process.exit(1);
      }
    });
}
