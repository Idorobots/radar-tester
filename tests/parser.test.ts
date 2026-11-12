import { describe, expect, it } from 'vitest';
import { Ld2450Parser } from '../src/protocol/parser.ts';
import {
  buildAck,
  buildCommand,
  buildDataFrame,
  buildEnableConfig,
  Command,
  decodeSignMagnitude,
  encodeSignMagnitude,
} from '../src/protocol/encode.ts';
import type { CommandAck, RadarFrame } from '../src/protocol/types.ts';

function collect() {
  const frames: RadarFrame[] = [];
  const acks: CommandAck[] = [];
  const parser = new Ld2450Parser({
    onFrame: (frame) => frames.push(frame),
    onAck: (ack) => acks.push(ack),
  });
  return { parser, frames, acks };
}

describe('sign-magnitude encoding', () => {
  it('round-trips positive and negative values', () => {
    for (const value of [0, 1, -1, 1234, -1234, 32767, -32767]) {
      const [low, high] = encodeSignMagnitude(value);
      expect(decodeSignMagnitude(low, high)).toBe(value);
    }
  });

  it('uses the high bit for positive values', () => {
    const [, positiveHigh] = encodeSignMagnitude(100);
    const [, negativeHigh] = encodeSignMagnitude(-100);
    expect(positiveHigh & 0x80).toBe(0x80);
    expect(negativeHigh & 0x80).toBe(0);
  });
});

describe('data frame parser', () => {
  it('decodes a complete 30-byte frame', () => {
    const { parser, frames } = collect();
    const frame = buildDataFrame([
      { xMm: 1234, yMm: -567, speedCms: -45, resolutionMm: 600, active: true },
      { xMm: 0, yMm: 5000, speedCms: 0, resolutionMm: 300, active: true },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
    ]);
    expect(frame).toHaveLength(30);

    parser.feed(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].targets[0]).toMatchObject({
      xMm: 1234,
      yMm: -567,
      speedCms: -45,
      resolutionMm: 600,
      active: true,
    });
    expect(frames[0].targets[1]).toMatchObject({ xMm: 0, yMm: 5000, active: true });
    expect(frames[0].targets[2].active).toBe(false);
  });

  it('handles frames split across chunks', () => {
    const { parser, frames } = collect();
    const frame = buildDataFrame([
      { xMm: -2000, yMm: 3000, speedCms: 25, resolutionMm: 400, active: true },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
    ]);

    parser.feed(frame.slice(0, 5));
    parser.feed(frame.slice(5, 18));
    parser.feed(frame.slice(18));
    expect(frames).toHaveLength(1);
    expect(frames[0].targets[0].xMm).toBe(-2000);
  });

  it('skips garbage before a valid frame', () => {
    const { parser, frames } = collect();
    parser.feed(Uint8Array.from([0x00, 0x42, 0x7f]));
    parser.feed(
      buildDataFrame([
        { xMm: 100, yMm: 200, speedCms: 0, resolutionMm: 0, active: true },
        { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
        { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
      ]),
    );
    expect(parser.stats.garbageBytes).toBe(3);
    expect(frames).toHaveLength(1);
  });

  it('resynchronises after a bad footer', () => {
    const { parser, frames } = collect();
    const broken = buildDataFrame([
      { xMm: 1, yMm: 2, speedCms: 3, resolutionMm: 4, active: true },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
    ]);
    broken[29] = 0x00;
    const good = buildDataFrame([
      { xMm: 500, yMm: 600, speedCms: -10, resolutionMm: 200, active: true },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
      { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
    ]);

    parser.feed(broken);
    parser.feed(good);
    expect(parser.stats.badFooters).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].targets[0].xMm).toBe(500);
  });
});

describe('command frames', () => {
  it('builds an enable-config command', () => {
    const frame = buildEnableConfig();
    expect(Array.from(frame.slice(0, 4))).toEqual([0xfd, 0xfc, 0xfb, 0xfa]);
    expect(frame[4]).toBe(4);
    expect(frame[5]).toBe(0);
    expect(frame[6]).toBe(Command.enableConfig);
    expect(Array.from(frame.slice(8, 10))).toEqual([0x01, 0x00]);
    expect(Array.from(frame.slice(-4))).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it('builds a simple command with the correct length', () => {
    const frame = buildCommand(Command.queryTargetMode);
    expect(frame).toHaveLength(12);
    expect(frame[4]).toBe(2);
    expect(frame[6]).toBe(Command.queryTargetMode);
  });

  it('parses a target-mode ACK', () => {
    const { parser, acks } = collect();
    parser.feed(buildAck(Command.queryTargetMode, Uint8Array.from([0x02, 0x00])));
    expect(acks).toHaveLength(1);
    expect(acks[0].command).toBe(Command.queryTargetMode);
    expect(acks[0].status).toBe(1);
    expect(Array.from(acks[0].payload)).toEqual([0x02, 0x00]);
  });

  it('continues parsing data frames after an ACK frame', () => {
    const { parser, frames, acks } = collect();
    parser.feed(buildAck(Command.queryMac, Uint8Array.from([1, 2, 3, 4, 5, 6])));
    parser.feed(
      buildDataFrame([
        { xMm: 10, yMm: 20, speedCms: 30, resolutionMm: 40, active: true },
        { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
        { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false },
      ]),
    );
    expect(acks).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });
});