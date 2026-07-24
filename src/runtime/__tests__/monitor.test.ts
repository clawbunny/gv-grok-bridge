/**
 * VoiceMonitor tests — discovered behavior of src/runtime/monitor.ts
 *
 * These tests document the polling, authorization, and event-emission behavior
 * of the generic voice monitor. The timeout test specifically guards against
 * the production incident where a hung Playwright call left pollMutex locked
 * forever and the bridge stopped detecting calls.
 */

import { VoiceMonitor } from '../monitor';
import { SilentLogger } from '../../logger';
import type { VoiceProvider } from '../../providers/contracts';
import type { CallInfo } from '../../types';

const silentLogger = new SilentLogger();

function createMockProvider(overrides: Partial<VoiceProvider> = {}): VoiceProvider {
  return {
    id: 'mock',
    name: 'Mock Provider',
    url: 'https://example.com',
    origin: 'https://example.com',
    initialize: jest.fn().mockResolvedValue(true),
    checkLoggedIn: jest.fn().mockResolvedValue(true),
    detectIncomingCall: jest.fn().mockResolvedValue(null),
    acceptCall: jest.fn().mockResolvedValue(undefined),
    declineCall: jest.fn().mockResolvedValue(undefined),
    isCallActive: jest.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function createMockPage() {
  return {} as any;
}

describe('VoiceMonitor', () => {
  let monitor: VoiceMonitor;

  beforeEach(() => {
    monitor = new VoiceMonitor(silentLogger);
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await monitor.stopMonitoring();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('polling', () => {
    it('starts monitoring and emits incomingCall for authorized callers', async () => {
      const call: CallInfo = { phoneNumber: '+14085506532', callerName: 'Alice', timestamp: new Date() };
      const provider = createMockProvider({
        detectIncomingCall: jest.fn().mockResolvedValue(call),
        acceptCall: jest.fn().mockResolvedValue(undefined),
      });
      const handler = jest.fn();
      monitor.on('incomingCall', handler);
      const acceptedHandler = jest.fn();
      monitor.on('callAccepted', acceptedHandler);

      await monitor.startMonitoring(createMockPage(), provider, {
        authorizedNumbers: ['+14085506532'],
        autoAccept: true,
        pollInterval: 1000,
      });

      expect(provider.detectIncomingCall).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(call);
      expect(acceptedHandler).toHaveBeenCalledWith(call);
      expect(provider.acceptCall).toHaveBeenCalled();
      expect(monitor.isInCall()).toBe(true);
    });

    it('declines calls from unauthorized numbers', async () => {
      const call: CallInfo = { phoneNumber: '+19998887777', callerName: 'Stranger', timestamp: new Date() };
      const provider = createMockProvider({
        detectIncomingCall: jest.fn().mockResolvedValue(call),
        declineCall: jest.fn().mockResolvedValue(undefined),
      });
      const handler = jest.fn();
      monitor.on('incomingCall', handler);

      await monitor.startMonitoring(createMockPage(), provider, {
        authorizedNumbers: ['+14085506532'],
        autoAccept: true,
        pollInterval: 1000,
      });

      expect(handler).toHaveBeenCalledWith(call);
      expect(provider.declineCall).toHaveBeenCalled();
      expect(monitor.isInCall()).toBe(false);
    });

    it('emits callEnded when active call is no longer active', async () => {
      const call: CallInfo = { phoneNumber: '+14085506532', callerName: 'Alice', timestamp: new Date() };
      let callActive = true;
      const provider = createMockProvider({
        detectIncomingCall: jest.fn().mockResolvedValue(call),
        acceptCall: jest.fn().mockResolvedValue(undefined),
        isCallActive: jest.fn().mockImplementation(() => Promise.resolve(callActive)),
      });
      const endedHandler = jest.fn();
      monitor.on('callEnded', endedHandler);

      await monitor.startMonitoring(createMockPage(), provider, {
        authorizedNumbers: ['+14085506532'],
        autoAccept: true,
        pollInterval: 1000,
      });
      expect(monitor.isInCall()).toBe(true);

      callActive = false;
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(endedHandler).toHaveBeenCalled();
      expect(monitor.isInCall()).toBe(false);
    });

    it('releases pollMutex and continues after a poll timeout', async () => {
      jest.useRealTimers();
      const provider = createMockProvider({
        detectIncomingCall: jest.fn().mockImplementation(() => new Promise(() => {})),
      });
      const errorHandler = jest.fn();
      monitor.on('error', errorHandler);

      await monitor.startMonitoring(createMockPage(), provider, {
        authorizedNumbers: ['+14085506532'],
        autoAccept: true,
        pollInterval: 500,
        pollTimeout: 300,
      });

      // Wait for the initial poll to hit the timeout.
      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0].message).toMatch(/Poll cycle timed out/);

      // Wait for the next scheduled poll to fire and also time out.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(provider.detectIncomingCall).toHaveBeenCalledTimes(2);
    });
  });
});
