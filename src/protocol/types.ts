export interface RadarTarget {
  xMm: number;
  yMm: number;
  speedCms: number;
  resolutionMm: number;
  active: boolean;
}

export interface RadarFrame {
  targets: [RadarTarget, RadarTarget, RadarTarget];
  receivedAt: number;
}

export interface ParserStats {
  frames: number;
  ackFrames: number;
  garbageBytes: number;
  badFooters: number;
  resyncs: number;
}

export interface CommandAck {
  command: number;
  status: number;
  result: number;
  payload: Uint8Array;
}

export interface SensorInfo {
  firmware: string | null;
  mac: string | null;
  targetMode: 'single' | 'multi' | null;
  bluetooth: 'on' | 'off' | null;
}

export type TargetMode = 'single' | 'multi';
export type BluetoothState = 'on' | 'off';