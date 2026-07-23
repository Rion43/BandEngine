import { HeartRateSample } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
export declare class HeartRateService {
    private encoder;
    private decoder;
    private write;
    constructor(encoder: PacketEncoder, decoder: PacketDecoder, write: (data: Uint8Array) => Promise<void>);
    start(): Promise<void>;
    stop(): Promise<void>;
    subscribe(): Promise<void>;
    unsubscribe(): Promise<void>;
    /** Parse a notification payload into a heart-rate sample (opcode 53). */
    parseSample(raw: Uint8Array): HeartRateSample;
}
