// BandEngine — Xiaomi Smart Band 9 BLE protocol library
// SPPv2-based protocol, Gadgetbridge-compatible auth

export * from './types.js';
export { Session } from './Session.js';
export { PacketEncoder } from './PacketEncoder.js';
export { PacketDecoder } from './PacketDecoder.js';
export { ProtoSerializer } from './ProtoSerializer.js';
export { AuthenticationManager } from './AuthenticationManager.js';
export { BluetoothManager } from './BluetoothManager.js';
export * from './crypto/index.js';
export * from './services/index.js';

// SPPv2 protocol modules
export { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode, SessionConfigOpcode } from './SppPacketV2.js';
export { SessionConfig } from './SessionConfig.js';
export { SppAuthProtocol } from './SppAuthProtocol.js';
export * from './SppAuthCrypto.js';
export * from './SppAuthMessages.js';
export { SppAckTracker } from './SppAckTracker.js';
export { encodeCommandClock } from './SppSystemMessages.js';

import { Session } from './Session.js';
import { BluetoothManager } from './BluetoothManager.js';
import { AuthenticationManager } from './AuthenticationManager.js';
import { PacketEncoder } from './PacketEncoder.js';
import { PacketDecoder } from './PacketDecoder.js';
import {
  HeartRateService,
  BatteryService,
  StepService,
  NotificationService,
} from './services/index.js';

export class BandEngine {
  readonly session: Session;
  readonly bluetooth: BluetoothManager;
  readonly auth: AuthenticationManager;
  readonly encoder: PacketEncoder;
  readonly decoder: PacketDecoder;

  readonly heartRate: HeartRateService;
  readonly battery: BatteryService;
  readonly steps: StepService;
  readonly notification: NotificationService;

  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  constructor(private longTermKey: Uint8Array) {
    this.session = new Session();

    this.bluetooth = new BluetoothManager();
    this.encoder = new PacketEncoder(this.session);
    this.decoder = new PacketDecoder(this.session);

    this.auth = new AuthenticationManager(this.session, longTermKey);

    this.heartRate = new HeartRateService(
      this.encoder, this.decoder,
      (d) => this.bluetooth.write(d),
    );
    this.battery = new BatteryService(
      this.encoder, this.decoder,
      (d) => this.bluetooth.write(d),
    );
    this.steps = new StepService(
      this.encoder, this.decoder,
      (d) => this.bluetooth.write(d),
    );
    this.notification = new NotificationService(
      this.encoder, this.decoder,
      (d) => this.bluetooth.write(d),
    );
  }

  async connect(): Promise<void> {
    await this.bluetooth.connect();
    this._connected = true;
  }

  async authenticate(): Promise<void> {
    await this.auth.handshake(
      (d) => this.bluetooth.write(d),
      () => this.bluetooth.onNotification(),
    );
  }

  disconnect(): void {
    this.bluetooth.disconnect();
    this._connected = false;
  }
}
