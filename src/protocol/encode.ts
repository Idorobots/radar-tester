import type { RadarTarget } from './types.ts';

export const DATA_HEADER = new Uint8Array([0xaa, 0xff, 0x03, 0x00]);
export const DATA_FOOTER = new Uint8Array([0x55, 0xcc]);
export const CMD_HEADER = new Uint8Array([0xfd, 0xfc, 0xfb, 0xfa]);
export const CMD_FOOTER = new Uint8Array([0x04, 0x03, 0x02, 0x01]);

export const DATA_FRAME_SIZE = 30;
export const TARGET_COUNT = 3;
export const TARGET_SIZE = 8;

export const Command = {
  enableConfig: 0xff,
  disableConfig: 0xfe,
  queryVersion: 0xa0,
  queryMac: 0xa5,
  reset: 0xa2,
  restart: 0xa3,
  bluetooth: 0xa4,
  setBaud: 0xa1,
  singleTarget: 0x80,
  multiTarget: 0x90,
  queryTargetMode: 0x91,
} as const;

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 256000, 460800] as const;
export type BaudRate = (typeof BAUD_RATES)[number];

export function baudRateIndex(rate: number): number | null {
  const index = BAUD_RATES.indexOf(rate as BaudRate);
  return index >= 0 ? index + 1 : null;
}

/** The LD2450 uses sign-magnitude, not two's complement: high bit means positive. */
export function encodeSignMagnitude(value: number): [number, number] {
  const rounded = Math.round(value);
  const magnitude = Math.abs(rounded) & 0x7fff;
  const high = (magnitude >> 8) | (rounded >= 0 ? 0x80 : 0x00);
  return [magnitude & 0xff, high];
}

export function decodeSignMagnitude(low: number, high: number): number {
  const magnitude = ((high & 0x7f) << 8) | low;
  return (high & 0x80) !== 0 ? magnitude : -magnitude;
}

export function buildDataFrame(targets: RadarTarget[]): Uint8Array {
  const frame = new Uint8Array(DATA_FRAME_SIZE);
  frame.set(DATA_HEADER, 0);
  for (let i = 0; i < TARGET_COUNT; i++) {
    const target = targets[i] ?? { xMm: 0, yMm: 0, speedCms: 0, resolutionMm: 0, active: false };
    const offset = DATA_HEADER.length + i * TARGET_SIZE;
    const [xLo, xHi] = encodeSignMagnitude(target.xMm);
    const [yLo, yHi] = encodeSignMagnitude(target.yMm);
    const [sLo, sHi] = encodeSignMagnitude(target.speedCms);
    frame[offset] = xLo;
    frame[offset + 1] = xHi;
    frame[offset + 2] = yLo;
    frame[offset + 3] = yHi;
    frame[offset + 4] = sLo;
    frame[offset + 5] = sHi;
    frame[offset + 6] = target.resolutionMm & 0xff;
    frame[offset + 7] = (target.resolutionMm >> 8) & 0xff;
  }
  frame.set(DATA_FOOTER, DATA_FRAME_SIZE - DATA_FOOTER.length);
  return frame;
}

/** Command frame: FD FC FB FA | len(2) | cmd(1) | 00 | value | 04 03 02 01 */
export function buildCommand(command: number, value: Uint8Array = new Uint8Array()): Uint8Array {
  const bodyLength = 2 + value.length;
  const frame = new Uint8Array(CMD_HEADER.length + 2 + bodyLength + CMD_FOOTER.length);
  frame.set(CMD_HEADER, 0);
  frame[4] = bodyLength & 0xff;
  frame[5] = (bodyLength >> 8) & 0xff;
  frame[6] = command;
  frame[7] = 0x00;
  frame.set(value, 8);
  frame.set(CMD_FOOTER, frame.length - CMD_FOOTER.length);
  return frame;
}

/** Command ACK: FD FC FB FA | len(2) | cmd(1) | status(1) | result(2) | value | footer */
export function buildAck(command: number, value: Uint8Array = new Uint8Array(), status = 0x01): Uint8Array {
  const bodyLength = 4 + value.length;
  const frame = new Uint8Array(CMD_HEADER.length + 2 + bodyLength + CMD_FOOTER.length);
  frame.set(CMD_HEADER, 0);
  frame[4] = bodyLength & 0xff;
  frame[5] = (bodyLength >> 8) & 0xff;
  frame[6] = command;
  frame[7] = status;
  frame[8] = 0x00;
  frame[9] = 0x00;
  frame.set(value, 10);
  frame.set(CMD_FOOTER, frame.length - CMD_FOOTER.length);
  return frame;
}

export function buildEnableConfig(): Uint8Array {
  return buildCommand(Command.enableConfig, new Uint8Array([0x01, 0x00]));
}

export function buildDisableConfig(): Uint8Array {
  return buildCommand(Command.disableConfig);
}

export function buildQueryVersion(): Uint8Array {
  return buildCommand(Command.queryVersion);
}

export function buildQueryMac(): Uint8Array {
  return buildCommand(Command.queryMac, new Uint8Array([0x01, 0x00]));
}

export function buildQueryTargetMode(): Uint8Array {
  return buildCommand(Command.queryTargetMode);
}

export function buildSetTargetMode(mode: 'single' | 'multi'): Uint8Array {
  return buildCommand(mode === 'single' ? Command.singleTarget : Command.multiTarget);
}

export function buildSetBluetooth(on: boolean): Uint8Array {
  return buildCommand(Command.bluetooth, new Uint8Array([on ? 0x01 : 0x00, 0x00]));
}

export function buildSetBaud(rate: number): Uint8Array {
  const index = baudRateIndex(rate);
  if (index === null) throw new Error(`Unsupported baud rate: ${rate}`);
  return buildCommand(Command.setBaud, new Uint8Array([index, 0x00]));
}

export function buildRestart(): Uint8Array {
  return buildCommand(Command.restart);
}

export function formatMac(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

export function formatVersion(bytes: Uint8Array): string {
  if (bytes.length < 8) return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const version = bytes.slice(2, 8);
  return `V${(version[1] & 0x0f).toString(16).toUpperCase()}.${version[0]
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()}.${version[5]
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()}${version[4].toString(16).padStart(2, '0').toUpperCase()}${version[3]
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()}${version[2].toString(16).padStart(2, '0').toUpperCase()}`;
}