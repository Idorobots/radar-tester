/**
 * Web Bluetooth source targeting the LD2450's native BLE service and common
 * BLE-UART bridges:
 *
 *  - HLK-LD2450 / JDY-31 class: service FFF0, notify FFF1, write FFF2
 *  - Nordic UART Service (NUS): service 6e400001…, TX notify …0003, RX write …0002
 *  - HM-10 / AT-09: service FFE0, characteristic FFE1 (notify + write)
 *
 * The LD2450 streams the same 30-byte UART frames over BLE notifications, so
 * parsing and metrics are identical to the serial path.
 */

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF1_NOTIFY = '0000fff1-0000-1000-8000-00805f9b34fb';
const FFF2_WRITE = '0000fff2-0000-1000-8000-00805f9b34fb';
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const FFE0_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const FFE1_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';

interface UartProfile {
  service: string;
  notify: string;
  write: string[];
  label: string;
}

const UART_PROFILES: UartProfile[] = [
  { service: FFF0_SERVICE, notify: FFF1_NOTIFY, write: [FFF2_WRITE, FFF1_NOTIFY], label: 'LD2450 / FFF0 UART' },
  { service: NUS_SERVICE, notify: NUS_TX, write: [NUS_RX], label: 'Nordic UART' },
  { service: FFE0_SERVICE, notify: FFE1_CHAR, write: [FFE1_CHAR], label: 'FFE0 UART (HM-10)' },
];

const OPTIONAL_SERVICES = UART_PROFILES.map((profile) => profile.service);
const WATCHDOG_MS = 10_000;
const STALE_DATA_MS = 30_000;
const MAX_RESUBSCRIBES = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BleInfo {
  deviceName: string | null;
  serviceLabel: string;
}

export interface BleCallbacks {
  onData: (data: Uint8Array) => void;
  onOpen: (info: BleInfo) => void;
  onClose: (error?: string) => void;
}

export class BleSource {
  private readonly callbacks: BleCallbacks;
  private device: BLEDevice | null = null;
  private notifyChar: BLERemoteGATTCharacteristic | null = null;
  private writeChar: BLERemoteGATTCharacteristic | null = null;
  private valueHandler: ((event: Event) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastDataAt = 0;
  private resubscribes = 0;
  private closing = false;

  constructor(callbacks: BleCallbacks) {
    this.callbacks = callbacks;
  }

  get open(): boolean {
    return this.device?.gatt?.connected === true;
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser');

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: OPTIONAL_SERVICES,
    });

    this.device = device;
    this.closing = false;
    this.disconnectHandler = () => {
      if (this.closing) return;
      this.cleanupWatchdog();
      this.device = null;
      this.notifyChar = null;
      this.writeChar = null;
      this.callbacks.onClose('Bluetooth device disconnected');
    };
    device.addEventListener('gattserverdisconnected', this.disconnectHandler);

    try {
      if (!device.gatt) throw new Error('Device has no GATT server');
      const server = await device.gatt.connect();
      await this.attach(server);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    const characteristic = this.writeChar;
    if (!characteristic) throw new Error('This BLE device has no writable UART characteristic');
    const withoutResponse = characteristic.properties.writeWithoutResponse === true;
    for (let offset = 0; offset < data.length; offset += 20) {
      const chunk = data.slice(offset, offset + 20);
      if (withoutResponse) await characteristic.writeValueWithoutResponse(chunk);
      else await characteristic.writeValue(chunk);
      if (offset + 20 < data.length) await sleep(10);
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.cleanupWatchdog();
    await this.detachGatt();
    this.callbacks.onClose();
    this.closing = false;
  }

  private async attach(server: BLERemoteGATTServer): Promise<void> {
    for (const profile of UART_PROFILES) {
      try {
        const service = await server.getPrimaryService(profile.service);
        const notify = await service.getCharacteristic(profile.notify);
        if (!notify.properties.notify && !notify.properties.indicate) continue;

        let write: BLERemoteGATTCharacteristic | null = null;
        for (const uuid of profile.write) {
          try {
            write = await service.getCharacteristic(uuid);
            break;
          } catch {
            /* try the next writable characteristic */
          }
        }

        this.valueHandler = (event: Event) => {
          const value = (event.target as BLERemoteGATTCharacteristic).value;
          if (!value) return;
          this.lastDataAt = Date.now();
          this.resubscribes = 0;
          this.callbacks.onData(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        };
        notify.addEventListener('characteristicvaluechanged', this.valueHandler);
        await notify.startNotifications();

        this.notifyChar = notify;
        this.writeChar = write;
        this.lastDataAt = Date.now();
        this.resubscribes = 0;
        this.startWatchdog();
        this.callbacks.onOpen({
          deviceName: this.device?.name ?? null,
          serviceLabel: profile.label,
        });
        return;
      } catch {
        /* service or characteristic missing — try the next profile */
      }
    }
    throw new Error('No BLE UART service found (tried LD2450 FFF0, Nordic UART and FFE0)');
  }

  private startWatchdog(): void {
    this.cleanupWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.device?.gatt?.connected || !this.notifyChar) return;
      if (Date.now() - this.lastDataAt < STALE_DATA_MS) return;
      void this.resubscribe();
    }, WATCHDOG_MS);
  }

  private cleanupWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private async resubscribe(): Promise<void> {
    const notify = this.notifyChar;
    if (!notify) return;
    if (this.resubscribes >= MAX_RESUBSCRIBES) {
      this.callbacks.onClose('No data received over BLE — the device may have stopped streaming');
      await this.detachGatt();
      return;
    }
    this.resubscribes++;
    try {
      await notify.stopNotifications();
      await sleep(250);
      await notify.startNotifications();
      this.lastDataAt = Date.now();
    } catch {
      this.callbacks.onClose('BLE notification stream failed');
      await this.detachGatt();
    }
  }

  private async detachGatt(): Promise<void> {
    const notify = this.notifyChar;
    const handler = this.valueHandler;
    this.notifyChar = null;
    this.writeChar = null;
    this.valueHandler = null;
    if (notify) {
      if (handler) notify.removeEventListener('characteristicvaluechanged', handler);
      try {
        await notify.stopNotifications();
      } catch {
        /* already gone */
      }
    }
    if (this.device && this.disconnectHandler) {
      this.device.removeEventListener('gattserverdisconnected', this.disconnectHandler);
    }
    this.disconnectHandler = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already gone */
    }
    this.device = null;
  }
}