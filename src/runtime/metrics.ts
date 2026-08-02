/**
 * CallMetricsWriter — appends one JSON record per call to a JSONL file.
 *
 * These records are the QoS ground truth: did the bridge answer, how fast,
 * did the AI session actually start, was audio flowing, how did it end.
 * The heartbeat watchdog can alert on patterns (accept_failed, silent_audio).
 */

import * as fs from 'fs';
import * as path from 'path';

export type CallEndReason =
  | 'caller_ended'        // voice provider reported the call is no longer active
  | 'accept_failed'       // we never managed to answer (bounded retries exhausted)
  | 'declined_unauthorized'
  | 'bridge_error'        // exception while activating the AI session
  | 'ai_voice_unavailable'// Grok voice session could not be established
  | 'canary_complete'     // self-test call finished by the bridge
  | 'service_stop';       // bridge stopped while a call was active

export interface CallRecord {
  instanceId: string;
  phoneNumber: string;
  callerName?: string;
  isCanary: boolean;
  /** ISO timestamps */
  detectedAt: string;
  acceptedAt?: string;
  bridgedAt?: string;
  endedAt: string;
  /** Derived latencies */
  acceptLatencyMs?: number;
  bridgeLatencyMs?: number;
  durationMs?: number;
  endReason: CallEndReason;
  /** True when audio was absent on the AI→caller direction during the call */
  silentAiAudio?: boolean;
  /** True when audio was absent on the caller→AI direction during the call */
  silentCallerAudio?: boolean;
}

export class CallMetricsWriter {
  constructor(
    private filePath: string,
    private fsImpl: typeof fs = fs,
  ) {}

  /** Append one call record. Silently fails — metrics must never break calls. */
  append(record: CallRecord): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!this.fsImpl.existsSync(dir)) {
        this.fsImpl.mkdirSync(dir, { recursive: true });
      }
      this.fsImpl.appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch {
      // best effort
    }
  }
}

/**
 * Tracks the in-progress call and produces a CallRecord at the end.
 */
export class CallTracker {
  private detectedAt: Date;
  private acceptedAt?: Date;
  private bridgedAt?: Date;
  silentAiAudio = false;
  silentCallerAudio = false;

  constructor(
    private instanceId: string,
    private phoneNumber: string,
    private callerName: string | undefined,
    private isCanary: boolean,
  ) {
    this.detectedAt = new Date();
  }

  markAccepted(): void {
    this.acceptedAt = new Date();
  }

  markBridged(): void {
    this.bridgedAt = new Date();
  }

  finish(endReason: CallEndReason): CallRecord {
    const endedAt = new Date();
    return {
      instanceId: this.instanceId,
      phoneNumber: this.phoneNumber,
      callerName: this.callerName || undefined,
      isCanary: this.isCanary,
      detectedAt: this.detectedAt.toISOString(),
      acceptedAt: this.acceptedAt?.toISOString(),
      bridgedAt: this.bridgedAt?.toISOString(),
      endedAt: endedAt.toISOString(),
      acceptLatencyMs: this.acceptedAt ? this.acceptedAt.getTime() - this.detectedAt.getTime() : undefined,
      bridgeLatencyMs: this.acceptedAt && this.bridgedAt
        ? this.bridgedAt.getTime() - this.acceptedAt.getTime()
        : undefined,
      durationMs: this.acceptedAt ? endedAt.getTime() - this.acceptedAt.getTime() : undefined,
      endReason,
      silentAiAudio: this.silentAiAudio || undefined,
      silentCallerAudio: this.silentCallerAudio || undefined,
    };
  }
}
