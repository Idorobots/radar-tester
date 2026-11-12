export interface SerialPortInfoLite {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

export interface SerialCallbacks {
  onData: (data: Uint8Array) => void;
  onOpen: (info: SerialPortInfoLite | null) => void;
  onClose: (error?: string) => void;
}

/** Standardized Bluetooth Classic Serial Port Profile UUID. */
export const BLUETOOTH_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

export const DEFAULT_BAUD = 256000;

/**
 * Common USB-UART bridge vendor IDs. Passing these as requestPort filters
 * hides built-in ports (ttyS*, etc.) that have no USB vendor ID.
 */
export const BRIDGE_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x067b },
  { usbVendorId: 0x2e8a },
  { usbVendorId: 0x303a },
  { usbVendorId: 0x2341 },
  { usbVendorId: 0x0483 },
  { usbVendorId: 0x1b4f },
  { usbVendorId: 0x239a },
  { bluetoothServiceClassId: BLUETOOTH_SPP_UUID },
];

export class SerialSource {
  private readonly callbacks: SerialCallbacks;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;

  constructor(callbacks: SerialCallbacks) {
    this.callbacks = callbacks;
  }

  get open(): boolean {
    return this.port !== null;
  }

  async connect(baudRate: number, filters?: SerialPortFilter[]): Promise<void> {
    if (!navigator.serial) throw new Error('Web Serial is not available in this browser');
    const options: SerialPortRequestOptions = filters
      ? { filters, allowedBluetoothServiceClassIds: [BLUETOOTH_SPP_UUID] }
      : { allowedBluetoothServiceClassIds: [BLUETOOTH_SPP_UUID] };
    const port = await navigator.serial.requestPort(options);
    await port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    this.port = port;
    this.closing = false;
    let info: SerialPortInfoLite | null = null;
    try {
      info = port.getInfo();
    } catch {
      info = null;
    }
    this.callbacks.onOpen(info);
    void this.readLoop(port);
  }

  async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port?.writable) throw new Error('Serial port is not writable');
    const writer = port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    const port = this.port;
    this.port = null;
    try {
      await this.reader?.cancel();
    } catch {
      /* reader already gone */
    }
    try {
      await port?.close();
    } catch {
      /* device already unplugged */
    }
    this.reader = null;
    this.closing = false;
    this.callbacks.onClose();
  }

  private async readLoop(port: SerialPort): Promise<void> {
    try {
      while (this.port === port && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (value && value.length > 0) this.callbacks.onData(value);
            if (done) break;
          }
        } finally {
          if (this.reader === reader) this.reader = null;
          reader.releaseLock();
        }
        if (this.port === port) break;
      }
    } catch (error) {
      if (this.port === port && !this.closing) {
        this.port = null;
        this.reader = null;
        this.callbacks.onClose(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (this.port === port) {
      this.port = null;
      this.reader = null;
      this.callbacks.onClose(this.closing ? undefined : 'Port stream ended');
    }
  }
}