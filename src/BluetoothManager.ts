// BluetoothManager — Web Bluetooth API wrapper for Mi Band 9

import { BLE_SERVICES } from './types.js';

export interface BluetoothTransport {
  write(data: Uint8Array): Promise<void>;
  onNotification(): Promise<Uint8Array>;
  disconnect(): void;
}

export class BluetoothManager implements BluetoothTransport {
  private server?: BluetoothRemoteGATTServer;
  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private notifyChar?: BluetoothRemoteGATTCharacteristic;
  private notificationBuffer: Uint8Array[] = [];
  private notificationResolve: ((data: Uint8Array) => void) | null = null;

  // ── Connection ──

  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [BLE_SERVICES.MI_BAND_SERVICE] },
        { namePrefix: 'Xiaomi Smart Band' },
      ],
      optionalServices: [
        BLE_SERVICES.AUTH_SERVICE,
      ],
    });

    this.server = device.gatt!;
    await this.server.connect();

    const service = await this.server.getPrimaryService(
      BLE_SERVICES.MI_BAND_SERVICE,
    );

    this.writeChar = await service.getCharacteristic(
      BLE_SERVICES.WRITE_CHAR,
    );

    this.notifyChar = await service.getCharacteristic(
      BLE_SERVICES.NOTIFY_CHAR,
    );
    await this.notifyChar.startNotifications();

    this.notifyChar.addEventListener(
      'characteristicvaluechanged',
      (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const value = new Uint8Array(target.value!.buffer);

        if (this.notificationResolve) {
          this.notificationResolve(value);
          this.notificationResolve = null;
        } else {
          this.notificationBuffer.push(value);
        }
      },
    );
  }

  // ── Write ──

  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('BluetoothManager: not connected');
    await this.writeChar.writeValue(data);
  }

  // ── Read next notification (one-shot) ──

  onNotification(): Promise<Uint8Array> {
    if (this.notificationBuffer.length > 0) {
      return Promise.resolve(this.notificationBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.notificationResolve = resolve;
    });
  }

  // ── Disconnect ──

  disconnect(): void {
    this.server?.disconnect();
    this.server = undefined;
    this.writeChar = undefined;
    this.notifyChar = undefined;
  }
}
