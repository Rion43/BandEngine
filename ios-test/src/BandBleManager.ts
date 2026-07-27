// BLE Manager for Xiaomi Smart Band 9 on iOS
// Uses react-native-ble-plx (CoreBluetooth bridge)
import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { BLE_SERVICE_UUID } from './types';
import {
  SppPacketV2,
  SppPacketType,
  ParsedPacket,
  SppChannel,
  SppDataOpcode,
  getOpCodeForChannel,
  SessionConfigOpcode,
} from './SppPacketV2';

export type BleStatusCallback = (text: string) => void;

export class BandBleManager {
  private manager: BleManager;
  private device: Device | null = null;
  private writeChar: Characteristic | null = null;
  private notifyChar: Characteristic | null = null;

  // SPP reassembly buffer
  private sppBuffer = new Uint8Array();

  // Notification queue for raw byte waiting
  private notifyQueue: Uint8Array[] = [];
  private notifyResolve: ((d: Uint8Array) => void) | null = null;

  // Callbacks
  private _onLog: BleStatusCallback = () => {};
  private _onDisconnect?: () => void;
  private _onPacket?: (pkt: ParsedPacket) => void;

  set onLog(cb: BleStatusCallback) {
    this._onLog = cb;
  }
  set onDisconnect(cb: (() => void) | undefined) {
    this._onDisconnect = cb;
  }
  set onPacket(cb: ((pkt: ParsedPacket) => void) | undefined) {
    this._onPacket = cb;
  }

  get isConnected(): boolean {
    return this.device !== null;
  }

  constructor() {
    this.manager = new BleManager();
  }

  /** Scan for devices advertising FE95, auto-connect to first found */
  async scanAndConnect(scanTimeoutMs = 15000): Promise<void> {
    this.log('Scanning for Xiaomi Smart Band (FE95)...');

    const devices: Device[] = [];

    // Wrap scan in a promise
    await new Promise<void>((resolve, reject) => {
      const scanTimer = setTimeout(() => {
        this.manager.stopDeviceScan();
        if (devices.length === 0) {
          reject(new Error('No Xiaomi Smart Band found (scan timeout)'));
        }
      }, scanTimeoutMs);

      this.manager.startDeviceScan(
        [BLE_SERVICE_UUID],
        null,
        (error, scannedDevice) => {
          if (error) {
            clearTimeout(scanTimer);
            this.manager.stopDeviceScan();
            reject(error);
            return;
          }
          if (scannedDevice && scannedDevice.name) {
            const name = scannedDevice.name;
            // Accept any device with FE95 service + Xiaomi name
            if (
              name.toLowerCase().includes('xiaomi') ||
              name.toLowerCase().includes('smart band')
            ) {
              this.log(`Found: ${name} (${scannedDevice.id})`);
              devices.push(scannedDevice);
              clearTimeout(scanTimer);
              this.manager.stopDeviceScan();
              resolve();
            }
          }
        },
      );
    });

    const target = devices[0];
    this.log(`Connecting to ${target.name ?? target.id}...`);
    await target.connect();
    this.device = target;
    this.log('Connected. Discovering services...');

    await target.discoverAllServicesAndCharacteristics();
    this.log('Services discovered.');

    // Get characteristics from FE95 service
    const chars = await target.characteristics(BLE_SERVICE_UUID);
    const wChar = chars.find(c =>
      c.uuid.toLowerCase().includes('005f'),
    );
    const nChar = chars.find(c =>
      c.uuid.toLowerCase().includes('005e'),
    );
    if (!wChar || !nChar) {
      throw new Error('005E/005F characteristics not found on FE95');
    }
    this.writeChar = wChar;
    this.notifyChar = nChar;
    this.log(`Write=${wChar.uuid} Notify=${nChar.uuid}`);

    // Disconnect handler
    target.onDisconnected(() => {
      this.log('❗ DISCONNECTED');
      this.device = null;
      this.writeChar = null;
      this.notifyChar = null;
      this._onDisconnect?.();
    });

    // Enable notifications
    nChar.monitor((err, char) => {
      if (err) {
        this.log(`Notify error: ${err.message}`);
        return;
      }
      if (char?.value) {
        const raw = this.base64ToBytes(char.value);
        this.onBleNotify(raw);
      }
    });

    // Reset SPP state
    this.sppBuffer = new Uint8Array();
    SppPacketV2.resetSequence();
    this.log('✓ Notifications enabled');
  }

  /** Write bytes to the write characteristic (with response) */
  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar || !this.device) {
      throw new Error('BLE not connected');
    }
    const b64 = this.bytesToBase64(data);
    await this.writeChar.writeWithResponse(b64);
  }

  /** Write bytes without response (faster, used for ACKs) */
  async writeWoR(data: Uint8Array): Promise<void> {
    if (!this.writeChar || !this.device) {
      throw new Error('BLE not connected');
    }
    const b64 = this.bytesToBase64(data);
    await this.writeChar.writeWithoutResponse(b64);
  }

  /** Send SPPv2 DataPacket (auto-selects opcode by channel) */
  async sendDataPacket(channel: SppChannel, payload: Uint8Array): Promise<void> {
    const opcode = getOpCodeForChannel(channel);
    const packet = SppPacketV2.buildDataPacket(channel, opcode, payload);
    await this.write(packet);
  }

  /** Wait for exactly one raw notification payload */
  waitForNotification(timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (this.notifyQueue.length > 0) {
        resolve(this.notifyQueue.shift()!);
        return;
      }
      const timer = setTimeout(() => {
        if (this.notifyResolve === resolve) this.notifyResolve = null;
        reject(new Error(`Notification timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.notifyResolve = (v: Uint8Array) => {
        clearTimeout(timer);
        resolve(v);
      };
    });
  }

  /** Drain pending SPP packets after a write */
  async drainNotifications(initialTimeout: number): Promise<void> {
    try {
      const n = await this.waitForNotification(initialTimeout);
      this.feedSpp(n);
      await delay(300);
      for (let i = 0; i < 5; i++) {
        try {
          const extra = await this.waitForNotification(1500);
          this.feedSpp(extra);
        } catch {
          break;
        }
      }
    } catch {
      // timeout OK
    }
  }

  disconnect(): void {
    this.device?.cancelConnection().catch(() => {});
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.sppBuffer = new Uint8Array();
    this.notifyQueue = [];
    this.notifyResolve = null;
  }

  // ── Private ──

  private log(msg: string): void {
    this._onLog(msg);
  }

  private onBleNotify(value: Uint8Array): void {
    if (this.notifyResolve) {
      this.notifyResolve(value);
      this.notifyResolve = null;
    } else {
      this.notifyQueue.push(value);
    }
    this.feedSpp(value);
  }

  private feedSpp(data: Uint8Array): void {
    const merged = new Uint8Array(this.sppBuffer.length + data.length);
    merged.set(this.sppBuffer);
    merged.set(data, this.sppBuffer.length);
    this.sppBuffer = merged;
    this.processSpp();
  }

  private processSpp(): void {
    while (this.sppBuffer.length >= 2) {
      if (this.sppBuffer[0] !== 0xa5 || this.sppBuffer[1] !== 0xa5) {
        let next = -1;
        for (let i = 1; i < this.sppBuffer.length - 1; i++) {
          if (this.sppBuffer[i] === 0xa5 && this.sppBuffer[i + 1] === 0xa5) {
            next = i;
            break;
          }
        }
        if (next < 0) {
          this.log('drop non-SPP bytes');
          this.sppBuffer = new Uint8Array();
          return;
        }
        this.sppBuffer = this.sppBuffer.slice(next);
      }

      const size = SppPacketV2.getExpectedPacketSize(this.sppBuffer);
      if (size === null || this.sppBuffer.length < size) return;

      const bytes = this.sppBuffer.slice(0, size);
      this.sppBuffer = this.sppBuffer.slice(size);
      const pkt = SppPacketV2.decode(bytes);
      if (!pkt) continue;
      this.handleSpp(pkt);
    }
  }

  private handleSpp(pkt: ParsedPacket): void {
    const tn = SppPacketType[pkt.packetType] || `?${pkt.packetType}`;
    this.log(`<< SPP ${tn} seq=${pkt.sequenceNumber} len=${pkt.payload.length}`);

    switch (pkt.packetType) {
      case SppPacketType.SESSION_CONFIG:
        this.log(
          `CONFIG opcode=${pkt.configOpcode} data=${bytesToHex(pkt.configData ?? pkt.payload)}`,
        );
        break;

      case SppPacketType.DATA: {
        // Auto-ACK
        const ack = SppPacketV2.buildAck(pkt.sequenceNumber);
        this.writeWoR(ack).catch(() => {});

        const ch = SppChannel[pkt.channel ?? -1] ?? '?';
        const op = SppDataOpcode[pkt.opcode ?? 0] ?? '?';
        this.log(`DATA ch=${ch} op=${op} payload(${pkt.payload.length}B)`);
        break;
      }

      case SppPacketType.ACK:
        this.log(`ACK seq=${pkt.sequenceNumber}`);
        break;
    }

    this._onPacket?.(pkt);
  }

  // ── Base64 helpers ──

  private bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  private base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
