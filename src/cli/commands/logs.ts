/**
 * voicebridge logs — tail logs for an instance via journalctl.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getServiceName } from '../systemd/template';

export function logsCommand(): Command {
  return new Command('logs')
    .description('View logs for an instance')
    .argument('<instance-id>', 'Instance identifier')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <count>', 'Number of lines to show', '50')
    .addHelpText('after', `
Examples:
  voicebridge logs martin-gv-grok-01
  voicebridge logs martin-gv-grok-01 -f        # Follow logs (like tail -f)
  voicebridge logs martin-gv-grok-01 -n 200    # Show 200 lines
`)
    .action((instanceId: string, options) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const service = getServiceName(instanceId);
      const args = ['--user', '-u', service, '-n', options.lines];
      if (options.follow) args.push('-f');

      try {
        execSync(`journalctl ${args.join(' ')}`, { stdio: 'inherit' });
      } catch {
        process.exit(1);
      }
    });
}
