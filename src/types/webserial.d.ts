/**
 * Minimal browser-API declarations not yet in TypeScript's DOM lib:
 * Web Serial, plus the subsets of Web Bluetooth used by the BLE source.
 */

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
}

interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
  allowedBluetoothServiceClassIds?: string[];
}

interface Navigator {
  readonly serial?: {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
    addEventListener(
      type: 'connect' | 'disconnect',
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
}

/* ---------- Web Bluetooth (BLE GATT) ---------- */

interface BLERequestDeviceFilter {
  services?: Array<string | number>;
  name?: string;
  namePrefix?: string;
}

interface BLERequestDeviceOptions {
  filters?: BLERequestDeviceFilter[];
  optionalServices?: Array<string | number>;
  acceptAllDevices?: boolean;
}

interface BLECharacteristicProperties {
  read?: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
  notify?: boolean;
  indicate?: boolean;
}

interface BLERemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: BLECharacteristicProperties;
  readonly value: DataView | null;
  startNotifications(): Promise<BLERemoteGATTCharacteristic>;
  stopNotifications(): Promise<BLERemoteGATTCharacteristic>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}

interface BLERemoteGATTService {
  readonly uuid: string;
  getCharacteristic(characteristic: string | number): Promise<BLERemoteGATTCharacteristic>;
}

interface BLERemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BLERemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BLERemoteGATTService>;
}

interface BLEDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BLERemoteGATTServer;
}

interface Bluetooth extends EventTarget {
  requestDevice(options?: BLERequestDeviceOptions): Promise<BLEDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}