export declare enum SppPacketType {
    ACK = 1,
    SESSION_CONFIG = 2,
    DATA = 3
}
/**
 * Logical channels (Gadgetbridge Channel enum).
 * Authentication ve ProtobufCommand ikisi de wire'da channel byte=1 gönderir
 * ama opcode farklıdır: Authentication → SEND_PLAINTEXT, ProtobufCommand → SEND_ENCRYPTED.
 * getRawChannel() mapping'i wire byte'ına çevirir.
 */
export declare enum SppChannel {
    UNKNOWN = -1,
    PROTOBUF_COMMAND = 1,
    DATA = 2,
    ACTIVITY = 5,
    AUTHENTICATION = 6
}
export declare enum SppDataOpcode {
    UNKNOWN = -1,
    SEND_PLAINTEXT = 1,
    SEND_ENCRYPTED = 2
}
export declare enum SessionConfigOpcode {
    START_SESSION_REQUEST = 1,
    START_SESSION_RESPONSE = 2,
    STOP_SESSION_REQUEST = 3,
    STOP_SESSION_RESPONSE = 4
}
export declare enum SessionConfigKey {
    VERSION = 1,
    MAX_PACKET_SIZE = 2,
    TX_WIN = 3,
    SEND_TIMEOUT = 4
}
export declare const PREAMBLE: Uint8Array<ArrayBuffer>;
export declare const HEADER_LENGTH = 8;
export interface ParsedPacket {
    packetType: SppPacketType;
    sequenceNumber: number;
    payload: Uint8Array;
    packetSize: number;
    channel?: SppChannel;
    opcode?: SppDataOpcode;
    configOpcode?: SessionConfigOpcode;
    configData?: Uint8Array;
}
export declare function crc16Arc(data: Uint8Array): number;
export declare function getOpCodeForChannel(channel: SppChannel): SppDataOpcode;
export declare class SppPacketV2 {
    private static sequenceCounter;
    static resetSequence(): void;
    static getNextSequence(): number;
    static getExpectedPacketSize(data: Uint8Array): number | null;
    static encode(packetType: SppPacketType, sequenceNumber: number, payload: Uint8Array): Uint8Array;
    static decode(data: Uint8Array): ParsedPacket | null;
    static buildSessionConfigRequest(): Uint8Array;
    /** Build SPPv2 DATA packet.
     * Gadgetbridge'de opCode==SEND_ENCRYPTED ? encryptV2(payload) : payload yapılır.
     * WebCrypto async olduğu için, encrypted payload'ı önce şifreleyip SEND_PLAINTEXT ile çağır.
     * SEND_ENCRYPTED flag'ı Gadgetbridge compat için korunur.
     */
    static buildDataPacket(channel: SppChannel, opcode: SppDataOpcode, payload: Uint8Array): Uint8Array;
    static buildAck(sequenceNumber: number): Uint8Array;
    static parseSessionConfigResponse(payload: Uint8Array): {
        version?: number[];
        maxPacketSize?: number;
        txWin?: number;
        sendTimeout?: number;
    } | null;
}
