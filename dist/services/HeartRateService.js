// HeartRateService — subscribe, unsubscribe, and read samples
import { OPCODES, CATEGORIES } from '../types.js';
import { ProtoSerializer } from '../ProtoSerializer.js';
export class HeartRateService {
    constructor(encoder, decoder, write) {
        this.encoder = encoder;
        this.decoder = decoder;
        this.write = write;
    }
    async start() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.HEALTH,
            opcode: OPCODES.HEART_RATE_START,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
    async stop() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.HEALTH,
            opcode: OPCODES.HEART_RATE_STOP,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
    async subscribe() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.HEALTH,
            opcode: OPCODES.HEART_RATE_SUBSCRIBE,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
    async unsubscribe() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.HEALTH,
            opcode: OPCODES.HEART_RATE_UNSUBSCRIBE,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
    /** Parse a notification payload into a heart-rate sample (opcode 53). */
    parseSample(raw) {
        return ProtoSerializer.decodeHeartRateSample(raw);
    }
}
