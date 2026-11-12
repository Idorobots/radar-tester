import type { CommandAck, ParserStats, RadarFrame, RadarTarget } from './types.ts';
import {
  CMD_FOOTER,
  CMD_HEADER,
  DATA_FOOTER,
  DATA_FRAME_SIZE,
  DATA_HEADER,
  TARGET_COUNT,
  TARGET_SIZE,
  decodeSignMagnitude,
} from './encode.ts';

const MAX_BUFFER = 8192;
const MAX_ACK_BODY = 1024;

function matches(buffer: number[], header: Uint8Array): boolean {
  for (let i = 0; i < header.length; i++) {
    if (buffer[i] !== header[i]) return false;
  }
  return true;
}

function matchesAt(buffer: number[], offset: number, needle: Uint8Array): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (buffer[offset + i] !== needle[i]) return false;
  }
  return true;
}

function decodeTarget(buffer: number[], offset: number): RadarTarget {
  const xMm = decodeSignMagnitude(buffer[offset], buffer[offset + 1]);
  const yMm = decodeSignMagnitude(buffer[offset + 2], buffer[offset + 3]);
  const speedCms = decodeSignMagnitude(buffer[offset + 4], buffer[offset + 5]);
  const resolutionMm = (buffer[offset + 6] | (buffer[offset + 7] << 8)) & 0xffff;
  return { xMm, yMm, speedCms, resolutionMm, active: xMm !== 0 || yMm !== 0 };
}

export interface ParserCallbacks {
  onFrame?: (frame: RadarFrame) => void;
  onAck?: (ack: CommandAck) => void;
}

export class Ld2450Parser {
  readonly stats: ParserStats = {
    frames: 0,
    ackFrames: 0,
    garbageBytes: 0,
    badFooters: 0,
    resyncs: 0,
  };

  private buffer: number[] = [];
  private readonly callbacks: ParserCallbacks;

  constructor(callbacks: ParserCallbacks = {}) {
    this.callbacks = callbacks;
  }

  feed(chunk: Uint8Array, now = performance.now()): void {
    for (let i = 0; i < chunk.length; i++) this.buffer.push(chunk[i]);

    if (this.buffer.length > MAX_BUFFER) {
      const drop = this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, drop);
      this.stats.garbageBytes += drop;
      this.stats.resyncs++;
    }

    this.drain(now);
  }

  reset(): void {
    this.buffer = [];
    this.stats.frames = 0;
    this.stats.ackFrames = 0;
    this.stats.garbageBytes = 0;
    this.stats.badFooters = 0;
    this.stats.resyncs = 0;
  }

  private drain(now: number): void {
    for (;;) {
      if (this.buffer.length < 4) return;

      if (matches(this.buffer, DATA_HEADER)) {
        if (this.buffer.length < DATA_FRAME_SIZE) return;
        const footerOffset = DATA_FRAME_SIZE - DATA_FOOTER.length;
        if (!matchesAt(this.buffer, footerOffset, DATA_FOOTER)) {
          this.stats.badFooters++;
          this.stats.resyncs++;
          this.buffer.shift();
          this.stats.garbageBytes++;
          continue;
        }
        const targets: RadarTarget[] = [];
        for (let i = 0; i < TARGET_COUNT; i++) {
          targets.push(decodeTarget(this.buffer, DATA_HEADER.length + i * TARGET_SIZE));
        }
        this.buffer.splice(0, DATA_FRAME_SIZE);
        this.stats.frames++;
        this.callbacks.onFrame?.({
          targets: targets as [RadarTarget, RadarTarget, RadarTarget],
          receivedAt: now,
        });
        continue;
      }

      if (matches(this.buffer, CMD_HEADER)) {
        if (this.buffer.length < 6) return;
        const bodyLength = this.buffer[4] | (this.buffer[5] << 8);
        if (bodyLength > MAX_ACK_BODY) {
          this.buffer.shift();
          this.stats.garbageBytes++;
          continue;
        }
        const frameLength = 4 + 2 + bodyLength + CMD_FOOTER.length;
        if (this.buffer.length < frameLength) return;
        const footerOffset = frameLength - CMD_FOOTER.length;
        if (!matchesAt(this.buffer, footerOffset, CMD_FOOTER)) {
          this.stats.badFooters++;
          this.stats.resyncs++;
          this.buffer.shift();
          this.stats.garbageBytes++;
          continue;
        }
        const ack: CommandAck = {
          command: this.buffer[6],
          status: this.buffer[7],
          result: this.buffer[8] | (this.buffer[9] << 8),
          payload: Uint8Array.from(this.buffer.slice(10, footerOffset)),
        };
        this.buffer.splice(0, frameLength);
        this.stats.ackFrames++;
        this.callbacks.onAck?.(ack);
        continue;
      }

      this.buffer.shift();
      this.stats.garbageBytes++;
    }
  }
}