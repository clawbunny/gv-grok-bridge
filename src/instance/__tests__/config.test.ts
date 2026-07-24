/**
 * Instance config tests — discovered behavior of src/instance/config.ts
 *
 * These tests document the default config shape, validation rules, and
 * the conversion from InstanceConfig to the runtime BridgeConfig.
 */

import {
  createDefaultConfig,
  validateInstanceConfig,
  instanceConfigToBridgeConfig,
} from '../config';

describe('InstanceConfig', () => {
  describe('createDefaultConfig()', () => {
    it('creates a default config with expected values', () => {
      const config = createDefaultConfig('test-instance');
      expect(config.instanceId).toBe('test-instance');
      expect(config.voiceProvider).toEqual({ type: 'google-voice' });
      expect(config.aiProvider).toEqual({ type: 'grok' });
      expect(config.authorizedNumbers).toEqual([]);
      expect(config.authorizedNames).toEqual([]);
      expect(config.headless).toBe(true);
      expect(config.autoAccept).toBe(true);
      expect(config.pollInterval).toBe(1000);
      expect(config.logLevel).toBe('info');
      expect(config.profilePath).toMatch(/\.config\/chromium$/);
    });
  });

  describe('validateInstanceConfig()', () => {
    it('returns no errors for a valid config', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      expect(validateInstanceConfig(config)).toEqual([]);
    });

    it('requires a non-empty instanceId', () => {
      const config = createDefaultConfig('');
      config.authorizedNumbers = ['+14085506532'];
      const errors = validateInstanceConfig(config);
      expect(errors).toContain(
        'instanceId must be a non-empty slug with only letters, numbers, underscores, and hyphens.'
      );
    });

    it('rejects instanceIds with invalid characters', () => {
      const config = createDefaultConfig('test instance!');
      config.authorizedNumbers = ['+14085506532'];
      const errors = validateInstanceConfig(config);
      expect(errors).toContain(
        'instanceId must be a non-empty slug with only letters, numbers, underscores, and hyphens.'
      );
    });

    it('requires a voice provider type', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      config.voiceProvider = { type: '' };
      const errors = validateInstanceConfig(config);
      expect(errors).toContain('voiceProvider.type is required.');
    });

    it('requires an AI provider type', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      config.aiProvider = { type: '' };
      const errors = validateInstanceConfig(config);
      expect(errors).toContain('aiProvider.type is required.');
    });

    it('requires at least one authorized number or name', () => {
      const config = createDefaultConfig('test-instance');
      const errors = validateInstanceConfig(config);
      expect(errors).toContain(
        'At least one authorized number or name must be configured.'
      );
    });

    it('allows authorized names without numbers', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNames = ['Alice'];
      expect(validateInstanceConfig(config)).toEqual([]);
    });

    it('requires pollInterval to be at least 100ms', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      config.pollInterval = 50;
      const errors = validateInstanceConfig(config);
      expect(errors).toContain('pollInterval must be at least 100ms.');
    });
  });

  describe('instanceConfigToBridgeConfig()', () => {
    it('maps instanceId to a sanitized namespace', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      const bridgeConfig = instanceConfigToBridgeConfig(config);
      expect(bridgeConfig.namespace).toBe('test-instance');
      expect(bridgeConfig.instanceId).toBe('test-instance');
    });

    it('sanitizes instanceId into a PulseAudio-safe namespace', () => {
      const config = createDefaultConfig('test instance!');
      config.authorizedNumbers = ['+14085506532'];
      const bridgeConfig = instanceConfigToBridgeConfig(config);
      expect(bridgeConfig.namespace).toBe('test_instance_');
    });

    it('builds a temp profile path under the OS temp dir', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      const bridgeConfig = instanceConfigToBridgeConfig(config);
      const tmp = require('os').tmpdir().replace(/\\/g, '\\\\');
      const expected = new RegExp(`${tmp}[/\\\\]gv-bridge[/\\\\]test-instance[/\\\\]chromium-copy$`);
      expect(bridgeConfig.tempProfilePath).toMatch(expected);
    });

    it('falls back to default profile path when not set', () => {
      const config = createDefaultConfig('test-instance');
      config.authorizedNumbers = ['+14085506532'];
      delete config.profilePath;
      const bridgeConfig = instanceConfigToBridgeConfig(config);
      expect(bridgeConfig.defaultProfilePath).toMatch(/\.config\/chromium$/);
    });
  });
});
