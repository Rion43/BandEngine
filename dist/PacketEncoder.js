// PacketEncoder — serialises BandPacket → BLE byte array
import { CATEGORIES, TRANSPORT_TYPE } from './types.js';
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
export class PacketEncoder {
    constructor(session) {
        this.session = session;
    }
    /**
     * Build raw BLE payload from a packet descriptor.
     * Applies encryption if transportType === ENCRYPTED.
     */
    async encode(packet) {
        const isPlain = packet.category === CATEGORIES.SYSTEM &&
            packet.opcode >= 17;
        const transportType = isPlain
            ? TRANSPORT_TYPE.PLAINTEXT
            : TRANSPORT_TYPE.ENCRYPTED;
        let payload = packet.payload;
        if (transportType === TRANSPORT_TYPE.ENCRYPTED) {
            payload = await this.session.encrypt(payload);
        }
        const header = new Uint8Array(3);
        header[0] = transportType;
        header[1] = packet.category;
        header[2] = packet.opcode;
        const out = new Uint8Array(3 + payload.length);
        out.set(header);
        out.set(payload, 3);
        return out;
    }
}
