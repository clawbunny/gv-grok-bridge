/**
 * voicebridge restart — restart an instance via systemd --user.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function restartCommand(): Command {
  return new Command('restart')
    .description('Restart an instance')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge restart martin-gv-grok-01
  voicebridge restart work-bridge

Tip:
  Restarting is useful after editing config with "voicebridge config <id>".
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      try {
        execSync(`systemctl --user restart ${service}`, { stdio: 'inherit' });
        console.log(`Instance "${instanceId}" restarted.`);
      } catch {
        process.exit(1);
      }
    });
}
