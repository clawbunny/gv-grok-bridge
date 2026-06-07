/**
 * voicebridge enable — enable auto-start on boot for an instance.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function enableCommand(): Command {
  return new Command('enable')
    .description('Enable auto-start on boot for an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge enable martin-gv-grok-01
  voicebridge enable work-bridge

Note:
  Requires "systemctl --user enable-linger <user>" to be run as root
  so user services start on boot without an interactive login.
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user enable ${service}`, { stdio: 'inherit' });
        console.log(`Instance "${instanceId}" enabled.`);
      } catch {
        process.exit(1);
      }
    });
}
