// SPPv2 Protocol Implementation for Xiaomi Smart Band 9
// Based on Gadgetbridge: XiaomiSppPacketV2.java (birebir)
// Wire: [0xA5 0xA5 | typeFlags(1) | sequence(1) | payloadLengthLE(2) | crc16ArcLE(2) | payload]
export var SppPacketType;
(function (SppPacketType) {
    SppPacketType[SppPacketType["ACK"] = 1] = "ACK";
    SppPacketType[SppPacketType["SESSION_CONFIG"] = 2] = "SESSION_CONFIG";
    SppPacketType[SppPacketType["DATA"] = 3] = "DATA";
})(SppPacketType || (SppPacketType = {}));
/**
 * Logical channels (Gadgetbridge Channel enum).
 * Authentication ve ProtobufCommand ikisi de wire'da channel byte=1 gönderir
 * ama opcode farklıdır: Authentication → SEND_PLAINTEXT, ProtobufCommand → SEND_ENCRYPTED.
 * getRawChannel() mapping'i wire byte'ına çevirir.
 */
export var SppChannel;
(function (SppChannel) {
    SppChannel[SppChannel["UNKNOWN"] = -1] = "UNKNOWN";
    SppChannel[SppChannel["PROTOBUF_COMMAND"] = 1] = "PROTOBUF_COMMAND";
    SppChannel[SppChannel["DATA"] = 2] = "DATA";
    SppChannel[SppChannel["ACTIVITY"] = 5] = "ACTIVITY";
    SppChannel[SppChannel["AUTHENTICATION"] = 6] = "AUTHENTICATION";
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
// ── CRC-16/ARC (Gadgetbridge birebir: poly=0x8005, init=0, xorout=0, refin, refout)
function reverse32(n) {
    let out = 0;
    for (let i = 0; i < 32; i++) {
        out = (out << 1) | (n & 1);
        n >>>= 1;
    }
    return out >>> 0;
}
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
// ── Channel ↔ raw byte / opcode mapping (Gadgetbridge XiaomiSppPacketV2.DataPacket birebir)
function getRawChannel(channel) {
    switch (channel) {
        case SppChannel.AUTHENTICATION:
        case SppChannel.PROTOBUF_COMMAND:
            return 1; // CHANNEL_PROTOBUF
        case SppChannel.DATA:
            return 2; // CHANNEL_DATA
        case SppChannel.ACTIVITY:
            return 5; // CHANNEL_ACTIVITY
        default:
            console.warn(`[SPPv2] getRawChannel: unknown channel ${channel}`);
            return 0;
    }
}
function getChannelFromRaw(raw) {
    switch (raw) {
        case 1: return SppChannel.PROTOBUF_COMMAND;
        case 2: return SppChannel.DATA;
        case 5: return SppChannel.ACTIVITY;
        default:
            console.warn(`[SPPv2] getChannelFromRaw: unknown raw ${raw}`);
            return SppChannel.UNKNOWN;
    }
}
export function getOpCodeForChannel(channel) {
    switch (channel) {
        case SppChannel.AUTHENTICATION:
        case SppChannel.DATA:
            return SppDataOpcode.SEND_PLAINTEXT;
        case SppChannel.PROTOBUF_COMMAND:
        case SppChannel.ACTIVITY:
            return SppDataOpcode.SEND_ENCRYPTED;
        default:
            console.warn(`[SPPv2] getOpCodeForChannel: unknown channel ${channel}`);
            return SppDataOpcode.UNKNOWN;
    }
}
// ── SPPv2 Packet encode/decode ──
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
    // ── Encode (Gadgetbridge birebir) ──
    static encode(packetType, sequenceNumber, payload) {
        const checksum = crc16Arc(payload);
        const out = new Uint8Array(HEADER_LENGTH + payload.length);
        const view = new DataView(out.buffer);
        out[0] = PREAMBLE[0];
        out[1] = PREAMBLE[1];
        out[2] = packetType & 0x0f; // flags + type
        out[3] = sequenceNumber & 0xff;
        view.setUint16(4, payload.length, true);
        view.setUint16(6, checksum, true);
        out.set(payload, HEADER_LENGTH);
        return out;
    }
    // ── Decode (Gadgetbridge birebir) ──
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
            console.warn(`[SPPv2] checksum mismatch expected=0x${expectedChecksum.toString(16)} actual=0x${actualChecksum.toString(16)}`);
            return null;
        }
        const parsed = {
            packetType: packetType,
            sequenceNumber,
            payload,
            packetSize,
        };
        // SESSION_CONFIG: opcode byte + TLV değerler
        if (packetType === SppPacketType.SESSION_CONFIG) {
            parsed.configOpcode = payload[0];
            parsed.configData = payload;
        }
        // DATA: channel(1, lower nibble) | opcode(1) | payload(N)
        else if (packetType === SppPacketType.DATA && payload.length >= 2) {
            parsed.channel = getChannelFromRaw(payload[0] & 0x0f);
            parsed.opcode = payload[1];
            parsed.payload = payload.slice(2);
        }
        return parsed;
    }
    // ── Build helpers ──
    static buildSessionConfigRequest() {
        // Gadgetbridge SessionConfigPacket.getPacketPayloadBytes birebir
        // seq=0 explicit, counter tüketilmez (Gadgetbridge initializeDevice.setSequenceNumber(0))
        const payload = new Uint8Array([
            SessionConfigOpcode.START_SESSION_REQUEST,
            // VERSION (key=1, size=3): 01.00.00
            SessionConfigKey.VERSION, 0x03, 0x00,
            0x01, 0x00, 0x00,
            // MAX_PACKET_SIZE (key=2, size=2): 0xfc00 = 64512
            SessionConfigKey.MAX_PACKET_SIZE, 0x02, 0x00,
            0x00, 0xfc,
            // TX_WIN (key=3, size=2): 0x0020 = 32
            SessionConfigKey.TX_WIN, 0x02, 0x00,
            0x20, 0x00,
            // SEND_TIMEOUT (key=4, size=2): 0x2710 = 10000ms
            SessionConfigKey.SEND_TIMEOUT, 0x02, 0x00,
            0x10, 0x27,
        ]);
        return this.encode(SppPacketType.SESSION_CONFIG, 0, payload);
    }
    /** Build SPPv2 DATA packet.
     * Gadgetbridge'de opCode==SEND_ENCRYPTED ? encryptV2(payload) : payload yapılır.
     * WebCrypto async olduğu için, encrypted payload'ı önce şifreleyip SEND_PLAINTEXT ile çağır.
     * SEND_ENCRYPTED flag'ı Gadgetbridge compat için korunur.
     */
    static buildDataPacket(channel, opcode, payload) {
        const packetPayload = new Uint8Array(2 + payload.length);
        packetPayload[0] = getRawChannel(channel) & 0x0f;
        packetPayload[1] = opcode & 0xff;
        packetPayload.set(payload, 2);
        return this.encode(SppPacketType.DATA, this.getNextSequence(), packetPayload);
    }
    static buildAck(sequenceNumber) {
        return this.encode(SppPacketType.ACK, sequenceNumber, new Uint8Array());
    }
    // ── SessionConfig response parser ──
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
                    console.log(`[SPPv2] SessionConfig version: ${result.version.join('.')}`);
                    break;
                case SessionConfigKey.MAX_PACKET_SIZE:
                    if (value.length >= 2)
                        result.maxPacketSize = value[0] | (value[1] << 8);
                    console.log(`[SPPv2] SessionConfig maxPacketSize: ${result.maxPacketSize}`);
                    break;
                case SessionConfigKey.TX_WIN:
                    if (value.length >= 2)
                        result.txWin = value[0] | (value[1] << 8);
                    console.log(`[SPPv2] SessionConfig txWin: ${result.txWin}`);
                    break;
                case SessionConfigKey.SEND_TIMEOUT:
                    if (value.length >= 2)
                        result.sendTimeout = value[0] | (value[1] << 8);
                    console.log(`[SPPv2] SessionConfig sendTimeout: ${result.sendTimeout}ms`);
                    break;
                default:
                    console.log(`[SPPv2] SessionConfig unknown key=${key} value=${Array.from(value)}`);
            }
        }
        return result;
    }
}
SppPacketV2.sequenceCounter = 0;
