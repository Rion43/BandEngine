// StepService — read step / distance / calorie data
import { OPCODES, CATEGORIES } from '../types.js';
import { ProtoSerializer } from '../ProtoSerializer.js';
export class StepService {
    constructor(encoder, decoder, write) {
        this.encoder = encoder;
        this.decoder = decoder;
        this.write = write;
    }
    async requestSteps() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.ACTIVITY,
            opcode: OPCODES.STEP_DATA,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
    /** Parse step notification payload. */
    parse(raw) {
        return ProtoSerializer.decodeStepData(raw);
    }
}
