/**
 * voicebridge setup — interactive wizard to create a new bridge instance.
 *
 * An "instance" is a complete voice bridge: one voice provider + one AI provider,
 * with its own audio devices, display, and systemd service.
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { listVoiceProviders, listAIProviders } from '../../providers';
import { createDefaultConfig, validateInstanceConfig, type InstanceConfig } from '../../instance/config';
import { saveInstance, instanceExists } from '../../instance/registry';
import { ensureInstanceDirs, getAudioNamespace } from '../../instance/paths';
import { allocateDisplay } from '../../instance/display-pool';
import { writeServiceFile, getServiceName } from '../systemd/template';
import { execSync } from 'child_process';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function setupCommand(): Command {
  const cmd = new Command('setup')
    .description('Create a new bridge instance interactively')
    .option('-i, --instance-id <id>', 'Instance ID (slug). Use only letters, numbers, underscores, and hyphens.')
    .option('-v, --voice-provider <type>', 'Voice provider type (e.g. google-voice)')
    .option('-a, --ai-provider <type>', 'AI provider type (e.g. grok)')
    .option('-n, --numbers <numbers>', 'Comma-separated authorized phone numbers in E.164 format, e.g. +12125551234,+13035556789')
    .option('--names <names>', 'Comma-separated authorized caller names (optional)')
    .option('--headless <bool>', 'Run headless with Xvfb', 'true')
    .option('--auto-accept <bool>', 'Auto-accept authorized calls', 'true')
    .option('--display <num>', 'Xvfb display number (auto-assign if omitted)')
    .option('--profile <path>', 'Path to Chromium profile with saved logins (default: ~/.config/chromium)')
    .addHelpText('after', `
Examples:
  voicebridge setup
  voicebridge setup -i martin-gv-grok-01 -v google-voice -a grok -n "+12125551234"
  voicebridge setup -i work-bridge -v google-voice -a grok -n "+12125551234,+13035556789" --names "Alice,Bob"

Prerequisites:
  You must be logged in to your voice and AI providers in Chromium before running.
  The bridge uses your Chromium profile, so close the browser before starting.
`);

  cmd.action(async (options) => {
    try {
      let instanceId = options.instanceId;
      if (!instanceId) {
        const defaultId = `${process.env.USER || 'user'}-gv-grok-01`;
        instanceId = await ask(`Instance ID [${defaultId}]: `);
        if (!instanceId) instanceId = defaultId;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
        console.error('Invalid instance ID. Use only letters, numbers, underscores, and hyphens.');
        process.exit(1);
      }

      if (instanceExists(instanceId)) {
        console.error(`Instance "${instanceId}" already exists.`);
        console.error('Run "voicebridge list" to see existing instances.');
        process.exit(1);
      }

      const config = createDefaultConfig(instanceId);

      // Voice provider
      const voiceProviders = listVoiceProviders();
      let voiceType = options.voiceProvider;
      if (!voiceType) {
        console.log(`\nAvailable voice providers: ${voiceProviders.join(', ')}`);
        voiceType = await ask(`Voice provider [${config.voiceProvider.type}]: `);
        if (!voiceType) voiceType = config.voiceProvider.type;
      }
      if (!voiceProviders.includes(voiceType)) {
        console.error(`Unknown voice provider: "${voiceType}"`);
        console.error(`Available: ${voiceProviders.join(', ')}`);
        process.exit(1);
      }
      config.voiceProvider = { type: voiceType };

      // AI provider
      const aiProviders = listAIProviders();
      let aiType = options.aiProvider;
      if (!aiType) {
        console.log(`\nAvailable AI providers: ${aiProviders.join(', ')}`);
        aiType = await ask(`AI provider [${config.aiProvider.type}]: `);
        if (!aiType) aiType = config.aiProvider.type;
      }
      if (!aiProviders.includes(aiType)) {
        console.error(`Unknown AI provider: "${aiType}"`);
        console.error(`Available: ${aiProviders.join(', ')}`);
        process.exit(1);
      }
      config.aiProvider = { type: aiType };

      // Authorized numbers
      let numbers = options.numbers;
      if (!numbers) {
        console.log('\nAuthorized phone numbers control who can call through.');
        console.log('Format: E.164 with +1 prefix, e.g. +12125551234');
        numbers = await ask('Authorized phone numbers (comma-separated): ');
      }
      if (numbers) {
        config.authorizedNumbers = numbers.split(',').map((s: string) => s.trim()).filter(Boolean);
      }

      // Authorized names
      let names = options.names;
      if (!names) {
        names = await ask('Authorized caller names (comma-separated, optional): ');
      }
      if (names) {
        config.authorizedNames = names.split(',').map((s: string) => s.trim()).filter(Boolean);
      }

      // Headless
      config.headless = options.headless.toLowerCase() === 'true';

      // Auto-accept
      config.autoAccept = options.autoAccept.toLowerCase() === 'true';

      // Display
      if (options.display) {
        config.displayNum = options.display.startsWith(':') ? options.display : `:${options.display}`;
      } else {
        config.displayNum = allocateDisplay(instanceId);
      }

      // Profile
      if (options.profile) {
        config.profilePath = options.profile;
      }

      const errors = validateInstanceConfig(config);
      if (errors.length > 0) {
        console.error('Configuration errors:');
        for (const err of errors) console.error(`  - ${err}`);
        process.exit(1);
      }

      ensureInstanceDirs(instanceId);
      saveInstance(config);

      const servicePath = writeServiceFile(instanceId);

      try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      } catch {
        console.warn('Warning: systemctl --user daemon-reload failed. You may need to run it manually.');
      }

      console.log('\n========================================');
      console.log(`  Instance "${instanceId}" created!`);
      console.log('========================================');
      console.log(`  Config:     ~/.config/gv-bridge/instances/${instanceId}.yaml`);
      console.log(`  Service:    ${servicePath}`);
      console.log(`  Display:    ${config.displayNum}`);
      console.log(`  Audio NS:   ${getAudioNamespace(instanceId)}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  Start now:     voicebridge start ${instanceId}`);
      console.log(`  Enable boot:   voicebridge enable ${instanceId}`);
      console.log(`  View status:   voicebridge status ${instanceId}`);
      console.log('');

      const startNow = await ask('Start the instance now? [y/N]: ');
      if (startNow.toLowerCase() === 'y') {
        execSync(`systemctl --user start ${getServiceName(instanceId)}`, { stdio: 'inherit' });
      }
    } catch (err) {
      console.error('Setup failed:', (err as Error).message);
      process.exit(1);
    }
  });

  return cmd;
}
