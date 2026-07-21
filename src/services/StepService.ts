// StepService — read step / distance / calorie data

import { OPCODES, CATEGORIES, StepData } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
import { ProtoSerializer } from '../ProtoSerializer.js';

export class StepService {
  constructor(
    private encoder: PacketEncoder,
    private decoder: PacketDecoder,
    private write: (data: Uint8Array) => Promise<void>,
  ) {}

  async requestSteps(): Promise<void> {
    const pkt = await this.encoder.encode({
      category: CATEGORIES.ACTIVITY,
      opcode: OPCODES.STEP_DATA,
      payload: new Uint8Array(),
    });
    await this.write(pkt);
  }

  /** Parse step notification payload. */
  parse(raw: Uint8Array): StepData {
    return ProtoSerializer.decodeStepData(raw);
  }
}
