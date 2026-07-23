// BluetoothManager — Web Bluetooth API wrapper for Mi Band 9 (SPPv2 protocol)

import { BLE_SERVICES } from './types.js';
import {
  ParsedPacket,
  SppChannel,
  SppDataOpcode,
  SppPacketType,
  SppPacketV2,
  SessionConfigOpcode,
} from './SppPacketV2.js';
import { SessionConfig, SessionConfigResponse } from './SessionConfig.js';

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

  private sppPacketBuffer = new Uint8Array();
  private sppPacketHandler?: (packet: ParsedPacket) => void;

  private sessionConfig = new SessionConfig();
  private sessionConfigSent = false;
  private sessionConfigConfirmed = false;

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

    // Gadgetbridge FE95 V2: RX/notify=005E, TX/write=005F
    this.notifyChar = await service.getCharacteristic(BLE_SERVICES.NOTIFY_CHAR);
    this.writeChar = await service.getCharacteristic(BLE_SERVICES.WRITE_CHAR);

    this.notifyChar.addEventListener('characteristicvaluechanged', (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      const value = new Uint8Array(target.value!.buffer);
      this.handleIncomingData(value);
    });
    await this.notifyChar.startNotifications();

    console.log('[BluetoothManager] FE95 connected');
    console.log('[BluetoothManager] notify=005E write=005F');

    SppPacketV2.resetSequence();
    await this.sendSessionConfig();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('BluetoothManager: not connected');
    console.log(`[BluetoothManager] write ${data.length}B ${toHex(data)}`);

    if (this.writeChar.properties.writeWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(data);
    } else {
      await this.writeChar.writeValue(data);
    }
  }

  onNotification(): Promise<Uint8Array> {
    if (this.notificationBuffer.length > 0) {
      return Promise.resolve(this.notificationBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.notificationResolve = resolve;
    });
  }

  setPacketHandler(handler: (packet: ParsedPacket) => void): void {
    this.sppPacketHandler = handler;
  }

  async sendProtobufCommand(commandBytes: Uint8Array): Promise<void> {
    const packet = SppPacketV2.buildDataPacket(
      SppChannel.AUTHENTICATION,
      SppDataOpcode.SEND_PLAINTEXT,
      commandBytes,
    );
    await this.write(packet);
  }

  getSessionConfigConfirmed(): boolean {
    return this.sessionConfigConfirmed;
  }

  onSessionConfigResponse(handler: (response: SessionConfigResponse) => void): void {
    this.sessionConfig.setResponseHandler(handler);
  }

  disconnect(): void {
    this.server?.disconnect();
    this.server = undefined;
    this.writeChar = undefined;
    this.notifyChar = undefined;
    this.notificationBuffer = [];
    this.notificationResolve = null;
    this.sppPacketBuffer = new Uint8Array();
    this.sessionConfigSent = false;
    this.sessionConfigConfirmed = false;
  }

  private async sendSessionConfig(): Promise<void> {
    if (this.sessionConfigSent) return;

    this.sessionConfig.setResponseHandler((response) => {
      this.sessionConfigConfirmed = true;
      console.log('[BluetoothManager] Session Config response parsed', response);
    });

    const packet = this.sessionConfig.buildRequest();
    console.log(`[BluetoothManager] send Session Config ${packet.length}B ${toHex(packet)}`);
    await this.write(packet);
    this.sessionConfigSent = true;
  }

  private handleIncomingData(value: Uint8Array): void {
    console.log(`[BluetoothManager] notify raw ${value.length}B ${toHex(value)}`);

    if (this.notificationResolve) {
      this.notificationResolve(value);
      this.notificationResolve = null;
    } else {
      this.notificationBuffer.push(value);
    }

    const merged = new Uint8Array(this.sppPacketBuffer.length + value.length);
    merged.set(this.sppPacketBuffer);
    merged.set(value, this.sppPacketBuffer.length);
    this.sppPacketBuffer = merged;

    this.processSppBuffer();
  }

  private processSppBuffer(): void {
    while (this.sppPacketBuffer.length >= 2) {
      if (this.sppPacketBuffer[0] !== 0xa5 || this.sppPacketBuffer[1] !== 0xa5) {
        const next = this.findNextPreamble(1);
        if (next < 0) {
          console.warn('[BluetoothManager] drop non-SPPv2 bytes', toHex(this.sppPacketBuffer));
          this.sppPacketBuffer = new Uint8Array();
          return;
        }
        console.warn('[BluetoothManager] skip bytes before SPPv2 preamble:', next);
        this.sppPacketBuffer = this.sppPacketBuffer.slice(next);
      }

      const expectedSize = SppPacketV2.getExpectedPacketSize(this.sppPacketBuffer);
      if (expectedSize === null || this.sppPacketBuffer.length < expectedSize) {
        return;
      }

      const packetBytes = this.sppPacketBuffer.slice(0, expectedSize);
      const packet = SppPacketV2.decode(packetBytes);
      this.sppPacketBuffer = this.sppPacketBuffer.slice(expectedSize);

      if (!packet) {
        console.warn('[BluetoothManager] invalid SPPv2 packet:', toHex(packetBytes));
        continue;
      }

      this.handleParsedPacket(packet);
    }
  }

  private handleParsedPacket(packet: ParsedPacket): void {
    console.log('[BluetoothManager] packet', {
      type: SppPacketType[packet.packetType],
      seq: packet.sequenceNumber,
      payloadLen: packet.payload.length,
      channel: packet.channel === undefined ? undefined : SppChannel[packet.channel],
      opcode: packet.opcode,
      configOpcode: packet.configOpcode === undefined ? undefined : SessionConfigOpcode[packet.configOpcode],
    });

    switch (packet.packetType) {
      case SppPacketType.SESSION_CONFIG:
        if (packet.configOpcode === SessionConfigOpcode.START_SESSION_RESPONSE && packet.configData) {
          this.sessionConfig.handleResponse(packet.configData);
        }
        break;
      case SppPacketType.DATA:
        void this.write(SppPacketV2.buildAck(packet.sequenceNumber));
        this.sppPacketHandler?.(packet);
        break;
      case SppPacketType.ACK:
        console.log('[BluetoothManager] ack for seq', packet.sequenceNumber);
        break;
    }
  }

  private findNextPreamble(startIndex: number): number {
    for (let i = startIndex; i < this.sppPacketBuffer.length - 1; i++) {
      if (this.sppPacketBuffer[i] === 0xa5 && this.sppPacketBuffer[i + 1] === 0xa5) {
        return i;
      }
    }
    return -1;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
