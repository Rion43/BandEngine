// PacketDecoder — parses raw BLE notification → BandPacket

import { BandPacket, TRANSPORT_TYPE } from './types.js';
import { Session } from './Session.js';

/**
 * Wire format:
 *
 *   type(1) | category(1) | opcode(1) | payload(N)
 *
 * type=100 → plain
 * type=101 → AES-CTR (decrypted before returning)
 */
export class PacketDecoder {
  constructor(private session: Session) {}

  /** Decode raw BLE write bytes into a structured packet. */
  async decode(raw: Uint8Array): Promise<BandPacket> {
    if (raw.length < 3) {
      throw new Error(`Packet too short: ${raw.length} bytes`);
    }

    const transportType = raw[0];
    const category = raw[1];
    const opcode = raw[2];
    let payload = raw.subarray(3);

    if (transportType === TRANSPORT_TYPE.ENCRYPTED) {
      payload = await this.session.decrypt(payload);
    }

    return { transportType, category, opcode, payload };
  }
}
