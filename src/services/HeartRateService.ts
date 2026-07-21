// HeartRateService — subscribe, unsubscribe, and read samples

import { OPCODES, CATEGORIES, HeartRateSample } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
import { ProtoSerializer } from '../ProtoSerializer.js';

export class HeartRateService {
  constructor(
    private encoder: PacketEncoder,
    private decoder: PacketDecoder,
    private write: (data: Uint8Array) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    const pkt = await this.encoder.encode({
      category: CATEGORIES.HEALTH,
      opcode: OPCODES.HEART_RATE_START,
      payload: new Uint8Array(),
    });
    await this.write(pkt);
  }

  async stop(): Promise<void> {
    const pkt = await this.encoder.encode({
      category: CATEGORIES.HEALTH,
      opcode: OPCODES.HEART_RATE_STOP,
      payload: new Uint8Array(),
    });
    await this.write(pkt);
  }

  async subscribe(): Promise<void> {
    const pkt = await this.encoder.encode({
      category: CATEGORIES.HEALTH,
      opcode: OPCODES.HEART_RATE_SUBSCRIBE,
      payload: new Uint8Array(),
    });
    await this.write(pkt);
  }

  async unsubscribe(): Promise<void> {
    const pkt = await this.encoder.encode({
      category: CATEGORIES.HEALTH,
      opcode: OPCODES.HEART_RATE_UNSUBSCRIBE,
      payload: new Uint8Array(),
    });
    await this.write(pkt);
  }

  /** Parse a notification payload into a heart-rate sample (opcode 53). */
  parseSample(raw: Uint8Array): HeartRateSample {
    return ProtoSerializer.decodeHeartRateSample(raw);
  }
}
