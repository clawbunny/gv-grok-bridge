#!/usr/bin/env node
/**
 * voicebridge — GV Bridge CLI for instance management.
 */

import { Command } from 'commander';
import { setupCommand } from './commands/setup';
import { listCommand } from './commands/list';
import { statusCommand } from './commands/status';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { restartCommand } from './commands/restart';
import { enableCommand } from './commands/enable';
import { disableCommand } from './commands/disable';
import { logsCommand } from './commands/logs';
import { configCommand } from './commands/config';
import { destroyCommand } from './commands/destroy';

const program = new Command();

program
  .name('voicebridge')
  .description('GV Bridge — manage voice bridge instances')
  .version('2.0.0')
  .addHelpText('after', `
Examples:
  voicebridge setup                           # Create a new instance interactively
  voicebridge setup -i my-bridge -v google-voice -a grok -n "+12125551234"
  voicebridge list                            # Show all instances
  voicebridge start my-bridge                 # Start an instance
  voicebridge status my-bridge                # View instance status
  voicebridge logs my-bridge -f               # Follow logs
  voicebridge enable my-bridge                # Auto-start on boot
  voicebridge stop my-bridge                  # Stop an instance
  voicebridge restart my-bridge               # Restart an instance
  voicebridge config my-bridge                # Edit instance config
  voicebridge destroy my-bridge               # Remove an instance

Getting started:
  1. Log in to https://voice.google.com and https://grok.com in Chromium
  2. Close Chromium so the profile is unlocked
  3. Run: voicebridge setup
  4. Run: voicebridge start <instance-id>
`);

program.addCommand(setupCommand());
program.addCommand(listCommand());
program.addCommand(statusCommand());
program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(restartCommand());
program.addCommand(enableCommand());
program.addCommand(disableCommand());
program.addCommand(logsCommand());
program.addCommand(configCommand());
program.addCommand(destroyCommand());

// Show help when no subcommand is given
if (process.argv.length <= 2) {
  program.help();
}

program.parse();
