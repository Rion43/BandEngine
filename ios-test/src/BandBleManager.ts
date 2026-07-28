// BLE Manager for Xiaomi Smart Band 9 on iOS
// Uses react-native-ble-plx (CoreBluetooth bridge)
import { BleManager, Device, Characteristic, Subscription } from 'react-native-ble-plx';
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

  // Parsed SPP packet queue for packet-level waiting
  private packetQueue: ParsedPacket[] = [];
  private packetResolve: ((pkt: ParsedPacket) => void) | null = null;

  // Track last processed buffer position to prevent duplicate SPP feed
  private lastBufferHash = 0;

  // Disconnect subscription
  private disconnectSub: Subscription | null = null;

  // Callbacks
  private _onLog: BleStatusCallback = () => {};
  private _onDisconnect?: () => void;
  private _onPacket?: (pkt: ParsedPacket) => void;

  set onLog(cb: BleStatusCallback) { this._onLog = cb; }
  set onDisconnect(cb: (() => void) | undefined) { this._onDisconnect = cb; }
  set onPacket(cb: ((pkt: ParsedPacket) => void) | undefined) { this._onPacket = cb; }

  get isConnected(): boolean { return this.device !== null; }

  constructor() { this.manager = new BleManager(); }

  /** Scan for devices advertising FE95, auto-connect to first found */
  async scanAndConnect(scanTimeoutMs = 15000): Promise<void> {
    this.log('Scanning for Xiaomi Smart Band (FE95)...');

    const devices: Device[] = [];

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
    const allChars = await target.characteristicsForService(BLE_SERVICE_UUID);
    const wChar = allChars.find((c: Characteristic) =>
      c.uuid.toLowerCase().includes('005f'),
    );
    const nChar = allChars.find((c: Characteristic) =>
      c.uuid.toLowerCase().includes('005e'),
    );
    if (!wChar || !nChar) {
      throw new Error('005E/005F characteristics not found on FE95');
    }
    this.writeChar = wChar;
    this.notifyChar = nChar;
    this.log(`Write=${wChar.uuid} Notify=${nChar.uuid}`);

    // Disconnect handler
    const disSub = target.onDisconnected(() => {
      this.log('DISCONNECTED');
      this.device = null;
      this.writeChar = null;
      this.notifyChar = null;
      this._onDisconnect?.();
    });
    this.disconnectSub = disSub;

    // Enable notifications
    nChar.monitor((err: import('react-native-ble-plx').BleError | null, char: Characteristic | null) => {
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
    this.log('Notifications enabled');
  }

  /** Write bytes to the write characteristic (with response) */
  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar || !this.device) throw new Error('BLE not connected');
    await this.writeChar.writeWithResponse(this.bytesToBase64(data));
  }

  /** Write bytes without response */
  async writeWoR(data: Uint8Array): Promise<void> {
    if (!this.writeChar || !this.device) throw new Error('BLE not connected');
    await this.writeChar.writeWithoutResponse(this.bytesToBase64(data));
  }

  /** Send SPPv2 DataPacket */
  async sendDataPacket(channel: SppChannel, payload: Uint8Array): Promise<void> {
    const opcode = getOpCodeForChannel(channel);
    await this.write(SppPacketV2.buildDataPacket(channel, opcode, payload));
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

  /** Wait for parsed SPP DATA packet */
  waitForPacket(timeoutMs: number): Promise<ParsedPacket> {
    return new Promise((resolve, reject) => {
      if (this.packetQueue.length > 0) {
        resolve(this.packetQueue.shift()!);
        return;
      }
      const timer = setTimeout(() => {
        if (this.packetResolve === resolve) this.packetResolve = null;
        reject(new Error(`Packet timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.packetResolve = (p: ParsedPacket) => {
        clearTimeout(timer);
        resolve(p);
      };
    });
  }

  /** Drain pending notifications after a write (used for session config) */
  async drainNotifications(initialTimeout: number): Promise<void> {
    try {
      await this.waitForNotification(initialTimeout);
      for (let i = 0; i < 5; i++) {
        try {
          await this.waitForNotification(1500);
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
    this.packetQueue = [];
    this.packetResolve = null;
  }

  // ── Private ──

  private log(msg: string): void { this._onLog(msg); }

  private onBleNotify(value: Uint8Array): void {
    // Save raw notification for waitForNotification
    if (this.notifyResolve) {
      this.notifyResolve(value);
      this.notifyResolve = null;
    } else {
      this.notifyQueue.push(value);
    }
    // Feed to SPP parser (single path — avoids duplicate processing)
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
    let maxIter = 32; // safety limit — prevent infinite loops
    while (this.sppBuffer.length >= 2 && maxIter-- > 0) {
      // Find valid preamble
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
      if (!pkt) continue; // decode failed (CRC mismatch), skip

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

        // Enqueue for packet-level waiters
        if (this.packetResolve) {
          this.packetResolve(pkt);
          this.packetResolve = null;
        } else {
          this.packetQueue.push(pkt);
        }
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
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  private base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
