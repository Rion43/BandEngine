// BluetoothManager — Web Bluetooth API wrapper for Xiaomi Smart Band 9 (SPPv2)
import { BLE_SERVICES } from './types.js';
import { SppChannel, SppDataOpcode, SppPacketType, SppPacketV2, SessionConfigOpcode, } from './SppPacketV2.js';
import { SessionConfig } from './SessionConfig.js';
import { SppAckTracker } from './SppAckTracker.js';
import { toHex as hex } from './SppAuthMessages.js';
/** Convert Uint8Array to BufferSource (ArrayBuffer) with correct type */
function buf(u8) {
    return u8.slice().buffer;
}
export class BluetoothManager {
    constructor() {
        this.notificationBuffer = [];
        this.notificationResolve = null;
        this.sppPacketBuffer = new Uint8Array();
        this.sessionConfig = new SessionConfig();
        this.sessionConfigSent = false;
        this.sessionConfigConfirmed = false;
        this.sessionConfigResponse = null;
        this.authProtocol = null;
        this.ackTracker = new SppAckTracker();
        this.pendingAuthResolve = null;
    }
    async connect() {
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { services: [BLE_SERVICES.MI_BAND_SERVICE] },
                { namePrefix: 'Xiaomi Smart Band' },
            ],
            optionalServices: [],
        });
        this.server = device.gatt;
        await this.server.connect();
        const service = await this.server.getPrimaryService(BLE_SERVICES.MI_BAND_SERVICE);
        this.notifyChar = await service.getCharacteristic(BLE_SERVICES.NOTIFY_CHAR);
        this.writeChar = await service.getCharacteristic(BLE_SERVICES.WRITE_CHAR);
        this.notifyChar.addEventListener('characteristicvaluechanged', (event) => {
            const target = event.target;
            const value = new Uint8Array(target.value.buffer);
            this.handleIncomingData(value);
        });
        await this.notifyChar.startNotifications();
        console.log(`[BluetoothManager] FE95 connected`);
        console.log(`[BluetoothManager] notify=005E write=005F`);
        SppPacketV2.resetSequence();
        await this.sendSessionConfig();
    }
    async write(data) {
        if (!this.writeChar)
            throw new Error('BluetoothManager: not connected');
        console.log(`[BluetoothManager] write (${data.length}B) ${hex(data)}`);
        if (this.writeChar.properties.writeWithoutResponse) {
            await this.writeChar.writeValueWithoutResponse(buf(data));
        }
        else {
            await this.writeChar.writeValue(buf(data));
        }
    }
    onNotification() {
        if (this.notificationBuffer.length > 0) {
            return Promise.resolve(this.notificationBuffer.shift());
        }
        return new Promise((resolve) => {
            this.notificationResolve = resolve;
        });
    }
    setPacketHandler(handler) {
        this.sppPacketHandler = handler;
    }
    async sendProtobufCommand(commandBytes, channel = SppChannel.AUTHENTICATION) {
        const packet = SppPacketV2.buildDataPacket(channel, SppDataOpcode.SEND_PLAINTEXT, commandBytes);
        const seq = SppPacketV2.getNextSequence() - 1;
        this.ackTracker.register(seq, 'protobuf');
        await this.write(packet);
    }
    getSessionConfigConfirmed() { return this.sessionConfigConfirmed; }
    getSessionConfigResponse() { return this.sessionConfigResponse; }
    waitForDataPayload(timeoutMs, label) {
        return new Promise((resolve) => {
            if (this.pendingAuthResolve)
                this.pendingAuthResolve(null);
            const timer = setTimeout(() => {
                this.pendingAuthResolve = null;
                console.warn(`[BluetoothManager] waitForDataPayload(${label}) timeout (${timeoutMs}ms)`);
                resolve(null);
            }, timeoutMs);
            this.pendingAuthResolve = (payload) => {
                clearTimeout(timer);
                this.pendingAuthResolve = null;
                resolve(payload);
            };
        });
    }
    /** Full auth handshake: PhoneNonce → WatchNonce → AuthStep3 → result */
    async authHandshake(authProtocol) {
        this.authProtocol = authProtocol;
        // Step 1: PhoneNonce
        const { packet: phoneNoncePacket } = authProtocol.buildPhoneNonce();
        console.log(`[BluetoothManager] auth step 1: send PhoneNonce`);
        await this.write(SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, phoneNoncePacket));
        // Step 2: WatchNonce
        const watchPayload = await this.waitForDataPayload(8000, 'WatchNonce');
        if (!watchPayload) {
            console.error(`[BluetoothManager] auth step 2: no WatchNonce`);
            return false;
        }
        console.log(`[BluetoothManager] auth step 2: WatchNonce received`);
        const step3 = await authProtocol.processWatchNonce(watchPayload);
        if (!step3) {
            console.error(`[BluetoothManager] auth step 2: WatchNonce processing failed`);
            return false;
        }
        // Step 3: AuthStep3
        console.log(`[BluetoothManager] auth step 3: send AuthStep3`);
        await this.write(SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, step3.authStep3Packet));
        // Step 4: Auth result
        const authPayload = await this.waitForDataPayload(8000, 'AuthResult');
        if (!authPayload) {
            console.error(`[BluetoothManager] auth step 4: no auth result`);
            return false;
        }
        const success = authProtocol.processAuthResponse(authPayload);
        console.log(`[BluetoothManager] auth: ${success ? '✓ SUCCESS' : '✗ FAILED'}`);
        return success;
    }
    disconnect() {
        this.server?.disconnect();
        this.server = undefined;
        this.writeChar = undefined;
        this.notifyChar = undefined;
        this.notificationBuffer = [];
        this.notificationResolve = null;
        this.sppPacketBuffer = new Uint8Array();
        this.sessionConfigSent = false;
        this.sessionConfigConfirmed = false;
        this.sessionConfigResponse = null;
        this.ackTracker.reset();
        this.authProtocol = null;
        this.pendingAuthResolve = null;
    }
    async sendSessionConfig() {
        if (this.sessionConfigSent)
            return;
        this.sessionConfig.setResponseHandler((response) => {
            this.sessionConfigConfirmed = true;
            this.sessionConfigResponse = response;
            console.log(`[BluetoothManager] Session Config confirmed`, response);
        });
        const packet = this.sessionConfig.buildRequest();
        console.log(`[BluetoothManager] send Session Config (${packet.length}B)`);
        await this.write(packet);
        this.sessionConfigSent = true;
    }
    handleIncomingData(value) {
        if (this.notificationResolve) {
            this.notificationResolve(value);
            this.notificationResolve = null;
        }
        else {
            this.notificationBuffer.push(value);
        }
        const merged = new Uint8Array(this.sppPacketBuffer.length + value.length);
        merged.set(this.sppPacketBuffer);
        merged.set(value, this.sppPacketBuffer.length);
        this.sppPacketBuffer = merged;
        this.processSppBuffer();
    }
    processSppBuffer() {
        while (this.sppPacketBuffer.length >= 2) {
            if (this.sppPacketBuffer[0] !== 0xa5 || this.sppPacketBuffer[1] !== 0xa5) {
                const next = this.findNextPreamble(1);
                if (next < 0) {
                    this.sppPacketBuffer = new Uint8Array();
                    return;
                }
                this.sppPacketBuffer = this.sppPacketBuffer.slice(next);
            }
            const expectedSize = SppPacketV2.getExpectedPacketSize(this.sppPacketBuffer);
            if (expectedSize === null || this.sppPacketBuffer.length < expectedSize)
                return;
            const packetBytes = this.sppPacketBuffer.slice(0, expectedSize);
            this.sppPacketBuffer = this.sppPacketBuffer.slice(expectedSize);
            const packet = SppPacketV2.decode(packetBytes);
            if (!packet)
                continue;
            this.handleParsedPacket(packet);
        }
    }
    handleParsedPacket(packet) {
        const typeName = SppPacketType[packet.packetType] || `?${packet.packetType}`;
        const extra = packet.packetType === SppPacketType.DATA ? ` ch=${SppChannel[packet.channel ?? -1] ?? '?'}` : '';
        console.log(`[BluetoothManager] recv ${typeName} seq=${packet.sequenceNumber} len=${packet.payload.length}${extra}`);
        switch (packet.packetType) {
            case SppPacketType.SESSION_CONFIG:
                if (packet.configOpcode === SessionConfigOpcode.START_SESSION_RESPONSE && packet.configData) {
                    this.sessionConfig.handleResponse(packet.configData);
                }
                break;
            case SppPacketType.DATA: {
                void this.write(SppPacketV2.buildAck(packet.sequenceNumber));
                if (packet.payload.length > 0 && this.pendingAuthResolve) {
                    this.pendingAuthResolve(packet.payload);
                }
                this.sppPacketHandler?.(packet);
                break;
            }
            case SppPacketType.ACK:
                console.log(`[BluetoothManager] ACK for seq=${packet.sequenceNumber}`);
                this.ackTracker.resolve(packet.sequenceNumber);
                break;
        }
    }
    findNextPreamble(startIndex) {
        for (let i = startIndex; i < this.sppPacketBuffer.length - 1; i++) {
            if (this.sppPacketBuffer[i] === 0xa5 && this.sppPacketBuffer[i + 1] === 0xa5)
                return i;
        }
        return -1;
    }
}
