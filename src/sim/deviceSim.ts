import type { RadarTarget } from '../protocol/types.ts';
import {
  CMD_FOOTER,
  CMD_HEADER,
  Command,
  buildAck,
  buildDataFrame,
} from '../protocol/encode.ts';

export interface SimCallbacks {
  onData: (data: Uint8Array) => void;
  onOpen: () => void;
  onClose: (error?: string) => void;
}

const SIM_VERSION = new Uint8Array([0x01, 0x00, 0x0a, 0x01, 0x2a, 0x09, 0x19, 0x24]);
const SIM_MAC = new Uint8Array([0xc0, 0xff, 0xee, 0x12, 0x34, 0x56]);

interface Point {
  x: number;
  y: number;
}

export class DeviceSimSource {
  private readonly callbacks: SimCallbacks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private elapsed = 0;
  private previous: Point[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private mode: 'single' | 'multi' = 'multi';
  private commandBuffer: number[] = [];
  private tickCount = 0;

  constructor(callbacks: SimCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    this.elapsed = 0;
    this.previous = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    this.commandBuffer = [];
    this.tickCount = 0;
    this.callbacks.onOpen();
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.callbacks.onClose();
  }

  /** Lets the simulator answer configuration commands just like real hardware. */
  write(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.commandBuffer.push(data[i]);
    this.drainCommands();
  }

  private drainCommands(): void {
    for (;;) {
      if (this.commandBuffer.length < 4) return;
      if (this.commandBuffer[0] !== CMD_HEADER[0]) {
        this.commandBuffer.shift();
        continue;
      }
      if (this.commandBuffer.length < 6) return;
      const bodyLength = this.commandBuffer[4] | (this.commandBuffer[5] << 8);
      const frameLength = 4 + 2 + bodyLength + CMD_FOOTER.length;
      if (frameLength > 256) {
        this.commandBuffer.shift();
        continue;
      }
      if (this.commandBuffer.length < frameLength) return;
      const command = this.commandBuffer[6];
      this.commandBuffer.splice(0, frameLength);
      this.handleCommand(command);
    }
  }

  private handleCommand(command: number): void {
    let responseValue = new Uint8Array();
    switch (command) {
      case Command.enableConfig:
        responseValue = new Uint8Array([0x01, 0x00, 0x40, 0x00]);
        break;
      case Command.disableConfig:
        break;
      case Command.queryVersion:
        responseValue = SIM_VERSION;
        break;
      case Command.queryMac:
        responseValue = SIM_MAC;
        break;
      case Command.queryTargetMode:
        responseValue = new Uint8Array([this.mode === 'single' ? 0x01 : 0x02, 0x00]);
        break;
      case Command.singleTarget:
        this.mode = 'single';
        break;
      case Command.multiTarget:
        this.mode = 'multi';
        break;
      case Command.bluetooth:
        break;
      case Command.setBaud:
        break;
      case Command.restart:
      case Command.reset:
        this.elapsed = 0;
        break;
      default:
        break;
    }
    setTimeout(() => {
      if (this.timer !== null) this.callbacks.onData(buildAck(command, responseValue));
    }, 25);
  }

  private tick(): void {
    this.elapsed += 100;
    const firstTick = this.tickCount === 0;
    this.tickCount++;
    const t = this.elapsed;
    const points: Point[] = [
      { x: 2200 * Math.sin(t / 3500), y: 3000 + 900 * Math.sin(t / 5000) },
      { x: -1500 + 250 * Math.sin(t / 8000), y: 5000 },
      { x: -3000 + 900 * Math.cos(t / 4500), y: 5200 - 2400 * Math.sin(t / 6000) },
    ];

    if (t % 27000 > 24000) {
      points[2] = { x: 0, y: 0 };
    }

    const targets: RadarTarget[] = points.map((point, index) => {
      const active = point.x !== 0 || point.y !== 0;
      const previous = this.previous[index];
      const previousDistance = Math.hypot(previous.x, previous.y);
      const distance = Math.hypot(point.x, point.y);
      const speed = active && !firstTick ? Math.round(distance - previousDistance) : 0;
      this.previous[index] = point;
      return {
        xMm: Math.round(point.x),
        yMm: Math.round(point.y),
        speedCms: index === 1 ? 0 : speed,
        resolutionMm: active ? 300 + index * 100 : 0,
        active,
      };
    });

    this.callbacks.onData(buildDataFrame(targets));
  }
}