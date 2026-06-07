/**
 * voicebridge config — edit an instance's YAML config file.
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { instanceExists } from '../../instance/registry';
import { getInstanceConfigPath } from '../../instance/paths';

export function configCommand(): Command {
  return new Command('config')
    .description('Edit an instance config (opens in $EDITOR)')
    .argument('<instance-id>', 'Instance identifier')
    .addHelpText('after', `
Examples:
  voicebridge config martin-gv-grok-01
  EDITOR=nano voicebridge config work-bridge

Tip:
  After editing, restart the instance for changes to take effect:
    voicebridge restart <instance-id>
`)
    .action((instanceId: string) => {
      if (!instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" not found.`);
        console.error('Run "voicebridge list" to see available instances.');
        process.exit(1);
      }

      const configPath = getInstanceConfigPath(instanceId);
      const editor = process.env.EDITOR || 'nano';
      spawn(editor, [configPath], { stdio: 'inherit' });
    });
}
