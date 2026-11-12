import type { CommandAck, SensorInfo } from './types.ts';
import {
  Command,
  buildCommand,
  buildDisableConfig,
  buildEnableConfig,
  buildSetBaud,
  formatMac,
  formatVersion,
} from './encode.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Pending {
  resolve: (ack: CommandAck) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type WriteFn = (data: Uint8Array) => Promise<void>;

export class CommandClient {
  private readonly write: WriteFn;
  private pending = new Map<number, Pending>();

  constructor(write: WriteFn) {
    this.write = write;
  }

  handleAck(ack: CommandAck): void {
    const pending = this.pending.get(ack.command);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ack.command);
    if (ack.status !== 0x01) {
      pending.reject(new Error(`Command 0x${ack.command.toString(16)} returned status 0x${ack.status.toString(16)}`));
      return;
    }
    if (ack.result !== 0) {
      pending.reject(new Error(`Command 0x${ack.command.toString(16)} failed with result ${ack.result}`));
      return;
    }
    pending.resolve(ack);
  }

  private expect(command: number, timeoutMs: number): Promise<CommandAck> {
    return new Promise<CommandAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command);
        reject(new Error(`No ACK for command 0x${command.toString(16)}`));
      }, timeoutMs);
      this.pending.set(command, { resolve, reject, timer });
    });
  }

  private async transact(command: number, value?: Uint8Array, timeoutMs = 1000): Promise<CommandAck> {
    const expected = this.expect(command, timeoutMs);
    try {
      await this.write(buildEnableConfig());
      await sleep(60);
      await this.write(buildCommand(command, value));
      await sleep(40);
      await this.write(buildDisableConfig());
    } catch (error) {
      const pending = this.pending.get(command);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(command);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return expected;
  }

  async queryVersion(): Promise<string> {
    const ack = await this.transact(Command.queryVersion);
    return formatVersion(ack.payload);
  }

  async queryMac(): Promise<string> {
    const ack = await this.transact(Command.queryMac);
    if (ack.payload.length < 6) throw new Error('Short MAC response');
    return formatMac(ack.payload);
  }

  async queryTargetMode(): Promise<'single' | 'multi'> {
    const ack = await this.transact(Command.queryTargetMode);
    return ack.payload[0] === 0x01 ? 'single' : 'multi';
  }

  async queryAll(): Promise<Partial<SensorInfo>> {
    const info: Partial<SensorInfo> = {};
    try {
      info.firmware = await this.queryVersion();
    } catch {
      info.firmware = null;
    }
    try {
      info.mac = await this.queryMac();
    } catch {
      info.mac = null;
    }
    try {
      info.targetMode = await this.queryTargetMode();
    } catch {
      info.targetMode = null;
    }
    return info;
  }

  async setTargetMode(mode: 'single' | 'multi'): Promise<void> {
    await this.transact(mode === 'single' ? Command.singleTarget : Command.multiTarget);
  }

  async setBluetooth(on: boolean): Promise<void> {
    await this.transact(Command.bluetooth, new Uint8Array([on ? 0x01 : 0x00, 0x00]));
  }

  async setBaud(rate: number): Promise<void> {
    const command = buildSetBaud(rate);
    const value = command.slice(8, command.length - 4);
    await this.transact(Command.setBaud, value);
  }

  async restart(): Promise<void> {
    await this.transact(Command.restart);
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pending.clear();
  }
}
