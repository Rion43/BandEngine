// BluetoothManager — Web Bluetooth API wrapper for Xiaomi Smart Band 9 (SPPv2)
// AŞAMA 3: Connect → Enable Notify → START_SESSION_REQUEST → Version doğrula → Auth hazır

import { BLE_SERVICES } from './types.js';
import {
  ParsedPacket, SppChannel, SppDataOpcode, SppPacketType, SppPacketV2, SessionConfigOpcode,
  getOpCodeForChannel,
} from './SppPacketV2.js';
import { SessionConfig, SessionConfigResponse } from './SessionConfig.js';

function buf(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer as ArrayBuffer;
}

export interface BluetoothTransport {
  write(data: Uint8Array): Promise<void>;
  onNotification(): Promise<Uint8Array>;
  disconnect(): void;
}

export class BluetoothManager implements BluetoothTransport {
  private server?: BluetoothRemoteGATTServer;
  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private notifyChar?: BluetoothRemoteGATTCharacteristic;
  private notificationQueue: Uint8Array[] = [];
  private notificationResolve: ((data: Uint8Array) => void) | null = null;

  // SPPv2 reassembly buffer
  private sppBuffer = new Uint8Array();
  private sppPacketHandler?: (packet: ParsedPacket) => void;

  // Session Config
  private sessionConfig = new SessionConfig();
  private sessionConfigSent = false;
  private sessionConfigConfirmed = false;
  private sessionConfigResponse: SessionConfigResponse | null = null;

  // Version (AŞAMA 3)
  private _versionValidated = false;
  private _onVersionReady?: () => void;

  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [BLE_SERVICES.MI_BAND_SERVICE] },
        { namePrefix: 'Xiaomi Smart Band' },
      ],
      optionalServices: [],
    });

    this.server = device.gatt!;
    await this.server.connect();

    const service = await this.server.getPrimaryService(BLE_SERVICES.MI_BAND_SERVICE);

    // Gadgetbridge FE95 V2: notify=005E, write=005F
    this.notifyChar = await service.getCharacteristic(BLE_SERVICES.NOTIFY_CHAR);
    this.writeChar = await service.getCharacteristic(BLE_SERVICES.WRITE_CHAR);

    // Persistent BLE notification handler
    this.notifyChar.addEventListener('characteristicvaluechanged', (event: Event) => {
      const target = event.target as unknown as BluetoothRemoteGATTCharacteristic;
      const value = new Uint8Array(target.value!.buffer);
      this.onBleData(value);
    });
    await this.notifyChar.startNotifications();

    console.log(`[BluetoothManager] FE95 connected`);
    console.log(`[BluetoothManager] notify=005E write=005F`);

    // SPPv2 session başlat
    this.sppBuffer = new Uint8Array();
    SppPacketV2.resetSequence();
    this.sessionConfigSent = false;
    this.sessionConfigConfirmed = false;

    await this.sendSessionConfig();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('BluetoothManager: not connected');
    console.log(`[BT] >> write (${data.length}B)`);
    console.log(`[BT] >> hex: ${toHex(data)}`);

    if (this.writeChar.properties.writeWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(buf(data));
    } else {
      await this.writeChar.writeValue(buf(data));
    }
  }

  /** Raw notification bekle (bypass SPPv2 parser) */
  onNotification(): Promise<Uint8Array> {
    if (this.notificationQueue.length > 0) {
      return Promise.resolve(this.notificationQueue.shift()!);
    }
    return new Promise((resolve) => {
      this.notificationResolve = resolve;
    });
  }

  setPacketHandler(handler: (packet: ParsedPacket) => void): void {
    this.sppPacketHandler = handler;
  }

  getSessionConfigConfirmed(): boolean { return this.sessionConfigConfirmed; }
  getSessionConfigResponse(): SessionConfigResponse | null { return this.sessionConfigResponse; }
  get versionValidated(): boolean { return this._versionValidated; }

  /** Version doğrulandığında tetiklenecek callback (auth başlatmak için). */
  onVersionReady(handler: () => void): void {
    this._onVersionReady = handler;
    if (this._versionValidated) handler();
  }

  /** SPPv2 DataPacket gönder */
  async sendDataPacket(channel: SppChannel, payload: Uint8Array): Promise<void> {
    const opcode = getOpCodeForChannel(channel);
    const packet = SppPacketV2.buildDataPacket(channel, opcode, payload);
    console.log(`[BT] >> SPPv2 DATA ch=${SppChannel[channel]} op=${SppDataOpcode[opcode]} seq=${packet[3]}`);
    await this.write(packet);
  }

  disconnect(): void {
    this.server?.disconnect();
    this.server = undefined;
    this.writeChar = undefined;
    this.notifyChar = undefined;
    this.notificationQueue = [];
    this.notificationResolve = null;
    this.sppBuffer = new Uint8Array();
    this.sessionConfigSent = false;
    this.sessionConfigConfirmed = false;
    this.sessionConfigResponse = null;
    this._versionValidated = false;
  }

  // ── Private ──

  private async sendSessionConfig(): Promise<void> {
    if (this.sessionConfigSent) return;

    this.sessionConfig.setResponseHandler((response: SessionConfigResponse) => {
      this.sessionConfigConfirmed = true;
      this.sessionConfigResponse = response;
      console.log(`[SessionConfig] RESPONSE PARSED: version=${response.version?.join('.')} maxPacketSize=${response.maxPacketSize} txWin=${response.txWin} sendTimeout=${response.sendTimeout}ms`);

      // AŞAMA 3: Version doğrula
      if (response.version && response.version.length >= 3) {
        const vStr = response.version.join('.');
        console.log(`[SessionConfig] Version validated: ${vStr}`);
        this._versionValidated = true;
        this._onVersionReady?.();
        this._onVersionReady = undefined;
      } else {
        // Gadgetbridge gibi: version yoksa da auth başlat
        console.warn(`[SessionConfig] Version not available: ${JSON.stringify(response.version)} — proceeding`);
        this._versionValidated = true;
        this._onVersionReady?.();
        this._onVersionReady = undefined;
      }
    });

    const packet = this.sessionConfig.buildRequest();
    await this.write(packet);
    this.sessionConfigSent = true;
  }

  /** Gelen BLE notification → SPPv2 reassembly */
  private onBleData(value: Uint8Array): void {
    // Push to queue for raw notification waiters
    if (this.notificationResolve) {
      this.notificationResolve(value);
      this.notificationResolve = null;
    } else {
      this.notificationQueue.push(value);
    }

    // SPPv2 reassembly
    const merged = new Uint8Array(this.sppBuffer.length + value.length);
    merged.set(this.sppBuffer);
    merged.set(value, this.sppBuffer.length);
    this.sppBuffer = merged;
    this.processSppBuffer();
  }

  private processSppBuffer(): void {
    while (this.sppBuffer.length >= 2) {
      // Find preamble [0xA5, 0xA5]
      if (this.sppBuffer[0] !== 0xa5 || this.sppBuffer[1] !== 0xa5) {
        let next = -1;
        for (let i = 1; i < this.sppBuffer.length - 1; i++) {
          if (this.sppBuffer[i] === 0xa5 && this.sppBuffer[i + 1] === 0xa5) { next = i; break; }
        }
        if (next < 0) { console.warn(`[BT] dropping non-SPPv2 bytes`); this.sppBuffer = new Uint8Array(); return; }
        console.warn(`[BT] skip ${next}B before preamble`);
        this.sppBuffer = this.sppBuffer.slice(next);
      }

      const expectedSize = SppPacketV2.getExpectedPacketSize(this.sppBuffer);
      if (expectedSize === null || this.sppBuffer.length < expectedSize) return;

      const packetBytes = this.sppBuffer.slice(0, expectedSize);
      this.sppBuffer = this.sppBuffer.slice(expectedSize);

      const packet = SppPacketV2.decode(packetBytes);
      if (!packet) continue;

      this.onSppPacket(packet);
    }
  }

  private onSppPacket(packet: ParsedPacket): void {
    const tname = SppPacketType[packet.packetType] || `?${packet.packetType}`;
    console.log(`[BT] << SPP ${tname} seq=${packet.sequenceNumber} len=${packet.payload.length}`);

    switch (packet.packetType) {
      case SppPacketType.SESSION_CONFIG: {
        console.log(`[BT] << SESSION_CONFIG opcode=${packet.configOpcode}`);
        console.log(`[BT] << HEX: ${toHex(packet.configData ?? packet.payload)}`);
        if (packet.configOpcode === SessionConfigOpcode.START_SESSION_RESPONSE && packet.configData) {
          this.sessionConfig.handleResponse(packet.configData);
        }
        break;
      }

      case SppPacketType.DATA: {
        // Send ACK immediately (Gadgetbridge behavior)
        void this.write(SppPacketV2.buildAck(packet.sequenceNumber));

        const chname = SppChannel[packet.channel ?? SppChannel.UNKNOWN] || '?';
        const opname = SppDataOpcode[packet.opcode ?? SppDataOpcode.UNKNOWN] || '?';
        console.log(`[BT] << DATA ch=${chname} op=${opname} payload(${packet.payload.length}B)`);
        console.log(`[BT] << HEX: ${toHex(packet.payload)}`);

        this.sppPacketHandler?.(packet);
        break;
      }

      case SppPacketType.ACK:
        console.log(`[BT] << ACK seq=${packet.sequenceNumber}`);
        break;
    }
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
