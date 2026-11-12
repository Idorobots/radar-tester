import type { RadarFrame } from '../protocol/types.ts';

export interface HealthInput {
  connected: boolean;
  hz: number;
  framesTotal: number;
  lastFrame: RadarFrame | null;
  lastAgeMs: number | null;
  totalBytes: number;
  bytesPerSec: number;
  garbageBytes: number;
  badFooters: number;
}

export type HealthLevel = 'off' | 'wait' | 'ok' | 'warn' | 'bad';

export interface HealthVerdict {
  level: HealthLevel;
  label: string;
  hint: string;
}

export function evaluateHealth(input: HealthInput): HealthVerdict {
  if (!input.connected) {
    return {
      level: 'off',
      label: 'OFFLINE',
      hint: 'Connect the sensor over USB-TTL or BLE, or press Simulate to exercise the app without hardware.',
    };
  }

  if (input.framesTotal === 0) {
    if (input.totalBytes === 0) {
      return {
        level: 'wait',
        label: 'NO DATA',
        hint: 'Port/BLE is open but no bytes are arriving. Check power, common ground, and that the sensor TX goes to the adapter RX.',
      };
    }
    if (input.totalBytes < 30) {
      return {
        level: 'wait',
        label: 'WAITING FOR FRAME',
        hint: `Only ${input.totalBytes} byte(s) received so far — waiting for a complete 30-byte LD2450 frame.`,
      };
    }
    return {
      level: 'warn',
      label: 'NO LD2450 FRAMES',
      hint: `Bytes are arriving (${input.bytesPerSec.toFixed(0)} B/s) but no AA FF 03 00 frames decode. Check the baud rate (256000 8N1 by default) and the wiring.`,
    };
  }

  if (input.lastAgeMs !== null && input.lastAgeMs > 2000) {
    return {
      level: 'bad',
      label: 'SIGNAL LOST',
      hint: `No valid frame for ${(input.lastAgeMs / 1000).toFixed(1)} s — the sensor stopped transmitting or was disconnected.`,
    };
  }

  const problems: string[] = [];
  if (input.hz < 6) problems.push(`low frame rate (${input.hz.toFixed(0)} fps, expected ~10)`);
  if (input.badFooters > 3 || input.badFooters > input.framesTotal * 0.05) {
    problems.push(`${input.badFooters} bad frame footer(s) — noise or wrong baud`);
  }
  if (input.garbageBytes > input.totalBytes * 0.15 && input.garbageBytes > 30) {
    problems.push(`${input.garbageBytes.toLocaleString()} garbage byte(s) — stream is not clean LD2450 data`);
  }

  if (problems.length > 0) {
    return {
      level: 'warn',
      label: 'DEGRADED',
      hint: problems.join(' · '),
    };
  }

  return {
    level: 'ok',
    label: input.hz >= 8 ? 'STREAMING · OK' : 'LIVE',
    hint: `Receiving ${input.hz.toFixed(1)} frames/s of valid LD2450 target data — sensor looks healthy.`,
  };
}