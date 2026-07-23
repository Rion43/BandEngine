// SPPv2 Protocol Implementation for Xiaomi Smart Band 9
// Based on Gadgetbridge: XiaomiSppPacketV2.java
// Wire: [0xA5 0xA5 | packetType(1) | sequence(1) | payloadLengthLE(2) | crc16ArcLE(2) | payload]
export var SppPacketType;
(function (SppPacketType) {
    SppPacketType[SppPacketType["ACK"] = 1] = "ACK";
    SppPacketType[SppPacketType["SESSION_CONFIG"] = 2] = "SESSION_CONFIG";
    SppPacketType[SppPacketType["DATA"] = 3] = "DATA";
})(SppPacketType || (SppPacketType = {}));
export var SppChannel;
(function (SppChannel) {
    SppChannel[SppChannel["UNKNOWN"] = -1] = "UNKNOWN";
    SppChannel[SppChannel["PROTOBUF_COMMAND"] = 1] = "PROTOBUF_COMMAND";
    SppChannel[SppChannel["AUTHENTICATION"] = 1] = "AUTHENTICATION";
    SppChannel[SppChannel["DATA"] = 2] = "DATA";
    SppChannel[SppChannel["ACTIVITY"] = 5] = "ACTIVITY";
})(SppChannel || (SppChannel = {}));
export var SppDataOpcode;
(function (SppDataOpcode) {
    SppDataOpcode[SppDataOpcode["UNKNOWN"] = -1] = "UNKNOWN";
    SppDataOpcode[SppDataOpcode["SEND_PLAINTEXT"] = 1] = "SEND_PLAINTEXT";
    SppDataOpcode[SppDataOpcode["SEND_ENCRYPTED"] = 2] = "SEND_ENCRYPTED";
})(SppDataOpcode || (SppDataOpcode = {}));
export var SessionConfigOpcode;
(function (SessionConfigOpcode) {
    SessionConfigOpcode[SessionConfigOpcode["START_SESSION_REQUEST"] = 1] = "START_SESSION_REQUEST";
    SessionConfigOpcode[SessionConfigOpcode["START_SESSION_RESPONSE"] = 2] = "START_SESSION_RESPONSE";
    SessionConfigOpcode[SessionConfigOpcode["STOP_SESSION_REQUEST"] = 3] = "STOP_SESSION_REQUEST";
    SessionConfigOpcode[SessionConfigOpcode["STOP_SESSION_RESPONSE"] = 4] = "STOP_SESSION_RESPONSE";
})(SessionConfigOpcode || (SessionConfigOpcode = {}));
export var SessionConfigKey;
(function (SessionConfigKey) {
    SessionConfigKey[SessionConfigKey["VERSION"] = 1] = "VERSION";
    SessionConfigKey[SessionConfigKey["MAX_PACKET_SIZE"] = 2] = "MAX_PACKET_SIZE";
    SessionConfigKey[SessionConfigKey["TX_WIN"] = 3] = "TX_WIN";
    SessionConfigKey[SessionConfigKey["SEND_TIMEOUT"] = 4] = "SEND_TIMEOUT";
})(SessionConfigKey || (SessionConfigKey = {}));
export const PREAMBLE = new Uint8Array([0xa5, 0xa5]);
export const HEADER_LENGTH = 8;
export function crc16Arc(data) {
    let crc = 0;
    for (const b of data) {
        for (let j = 0; j < 8; j++) {
            crc <<= 1;
            if ((((crc >> 16) & 1) ^ ((b >> j) & 1)) === 1) {
                crc ^= 0x8005;
            }
        }
    }
    return (reverse32(crc) >>> 16) & 0xffff;
}
function reverse32(n) {
    let out = 0;
    for (let i = 0; i < 32; i++) {
        out = (out << 1) | (n & 1);
        n >>>= 1;
    }
    return out >>> 0;
}
export class SppPacketV2 {
    static resetSequence() {
        this.sequenceCounter = 0;
    }
    static getNextSequence() {
        const seq = this.sequenceCounter & 0xff;
        this.sequenceCounter = (this.sequenceCounter + 1) & 0xff;
        return seq;
    }
    static getExpectedPacketSize(data) {
        if (data.length < HEADER_LENGTH)
            return null;
        if (data[0] !== PREAMBLE[0] || data[1] !== PREAMBLE[1])
            return null;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return HEADER_LENGTH + view.getUint16(4, true);
    }
    static encode(packetType, sequenceNumber, payload) {
        const checksum = crc16Arc(payload);
        const out = new Uint8Array(HEADER_LENGTH + payload.length);
        const view = new DataView(out.buffer);
        out[0] = PREAMBLE[0];
        out[1] = PREAMBLE[1];
        out[2] = packetType & 0x0f;
        out[3] = sequenceNumber & 0xff;
        view.setUint16(4, payload.length, true);
        view.setUint16(6, checksum, true);
        out.set(payload, HEADER_LENGTH);
        return out;
    }
    static decode(data) {
        const packetSize = this.getExpectedPacketSize(data);
        if (packetSize === null || data.length < packetSize)
            return null;
        const packetType = data[2] & 0x0f;
        const sequenceNumber = data[3];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const payloadLength = view.getUint16(4, true);
        const expectedChecksum = view.getUint16(6, true);
        const payload = data.slice(HEADER_LENGTH, HEADER_LENGTH + payloadLength);
        const actualChecksum = crc16Arc(payload);
        if (actualChecksum !== expectedChecksum) {
            console.warn('[SPPv2] checksum mismatch', {
                expected: expectedChecksum.toString(16),
                actual: actualChecksum.toString(16),
            });
            return null;
        }
        const parsed = {
            packetType: packetType,
            sequenceNumber,
            payload,
            packetSize,
        };
        if (packetType === SppPacketType.SESSION_CONFIG) {
            parsed.configOpcode = payload[0];
            parsed.configData = payload;
        }
        else if (packetType === SppPacketType.DATA && payload.length >= 2) {
            parsed.channel = (payload[0] & 0x0f);
            parsed.opcode = payload[1];
            parsed.payload = payload.slice(2);
        }
        return parsed;
    }
    static buildSessionConfigRequest() {
        const payload = new Uint8Array([
            SessionConfigOpcode.START_SESSION_REQUEST,
            SessionConfigKey.VERSION, 0x03, 0x00, 0x01, 0x00, 0x00,
            SessionConfigKey.MAX_PACKET_SIZE, 0x02, 0x00, 0x00, 0xfc,
            SessionConfigKey.TX_WIN, 0x02, 0x00, 0x20, 0x00,
            SessionConfigKey.SEND_TIMEOUT, 0x02, 0x00, 0x10, 0x27,
        ]);
        return this.encode(SppPacketType.SESSION_CONFIG, this.getNextSequence(), payload);
    }
    static buildDataPacket(channel, opcode, payload) {
        const packetPayload = new Uint8Array(2 + payload.length);
        packetPayload[0] = channel & 0x0f;
        packetPayload[1] = opcode & 0xff;
        packetPayload.set(payload, 2);
        return this.encode(SppPacketType.DATA, this.getNextSequence(), packetPayload);
    }
    static buildAck(sequenceNumber) {
        return this.encode(SppPacketType.ACK, sequenceNumber, new Uint8Array());
    }
    static parseSessionConfigResponse(payload) {
        if (payload.length < 1 || payload[0] !== SessionConfigOpcode.START_SESSION_RESPONSE) {
            return null;
        }
        const result = {};
        let offset = 1;
        while (offset + 3 <= payload.length) {
            const key = payload[offset];
            const size = payload[offset + 1] | (payload[offset + 2] << 8);
            offset += 3;
            if (offset + size > payload.length)
                break;
            const value = payload.slice(offset, offset + size);
            offset += size;
            switch (key) {
                case SessionConfigKey.VERSION:
                    result.version = Array.from(value);
                    break;
                case SessionConfigKey.MAX_PACKET_SIZE:
                    if (value.length >= 2)
                        result.maxPacketSize = value[0] | (value[1] << 8);
                    break;
                case SessionConfigKey.TX_WIN:
                    if (value.length >= 2)
                        result.txWin = value[0] | (value[1] << 8);
                    break;
                case SessionConfigKey.SEND_TIMEOUT:
                    if (value.length >= 2)
                        result.sendTimeout = value[0] | (value[1] << 8);
                    break;
            }
        }
        return result;
    }
}
SppPacketV2.sequenceCounter = 0;
