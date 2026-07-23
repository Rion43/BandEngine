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
import { Session } from './Session.js';
import { BluetoothManager } from './BluetoothManager.js';
import { AuthenticationManager } from './AuthenticationManager.js';
import { PacketEncoder } from './PacketEncoder.js';
import { PacketDecoder } from './PacketDecoder.js';
import { HeartRateService, BatteryService, StepService, NotificationService, } from './services/index.js';
export class BandEngine {
    get connected() {
        return this._connected;
    }
    constructor(longTermKey) {
        this.longTermKey = longTermKey;
        this._connected = false;
        this.session = new Session();
        this.bluetooth = new BluetoothManager();
        this.encoder = new PacketEncoder(this.session);
        this.decoder = new PacketDecoder(this.session);
        this.auth = new AuthenticationManager(this.session, longTermKey);
        this.heartRate = new HeartRateService(this.encoder, this.decoder, (d) => this.bluetooth.write(d));
        this.battery = new BatteryService(this.encoder, this.decoder, (d) => this.bluetooth.write(d));
        this.steps = new StepService(this.encoder, this.decoder, (d) => this.bluetooth.write(d));
        this.notification = new NotificationService(this.encoder, this.decoder, (d) => this.bluetooth.write(d));
    }
    async connect() {
        await this.bluetooth.connect();
        this._connected = true;
    }
    async authenticate() {
        await this.auth.handshake((d) => this.bluetooth.write(d), () => this.bluetooth.onNotification());
    }
    disconnect() {
        this.bluetooth.disconnect();
        this._connected = false;
    }
}
