/**
 * voicebridge status — show systemd status for one instance.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show systemd status for an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge status martin-gv-grok-01
  voicebridge status work-bridge
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user status ${service}`, { stdio: 'inherit' });
      } catch {
        process.exit(1);
      }
    });
}
