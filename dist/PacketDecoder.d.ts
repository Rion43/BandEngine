import { BandPacket } from './types.js';
import { Session } from './Session.js';
/**
 * Wire format:
 *
 *   type(1) | category(1) | opcode(1) | payload(N)
 *
 * type=100 → plain
 * type=101 → AES-CTR (decrypted before returning)
 */
export declare class PacketDecoder {
    private session;
    constructor(session: Session);
    /** Decode raw BLE write bytes into a structured packet. */
    decode(raw: Uint8Array): Promise<BandPacket>;
}
