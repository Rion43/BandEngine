import { BandPacket } from './types.js';
import { Session } from './Session.js';
/**
 * Wire format:
 *
 *   type(1) | category(1) | opcode(1) | payload(N)
 *
 * type 100 = plaintext
 * type 101 = AES-CTR ciphertext
 *
 * The Mi Band checks:
 *   (category === 1 && opcode >= 17)  → plaintext
 *   else                              → encrypted
 */
export declare class PacketEncoder {
    private session;
    constructor(session: Session);
    /**
     * Build raw BLE payload from a packet descriptor.
     * Applies encryption if transportType === ENCRYPTED.
     */
    encode(packet: Omit<BandPacket, 'transportType'>): Promise<Uint8Array>;
}
