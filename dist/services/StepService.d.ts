import { StepData } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
export declare class StepService {
    private encoder;
    private decoder;
    private write;
    constructor(encoder: PacketEncoder, decoder: PacketDecoder, write: (data: Uint8Array) => Promise<void>);
    requestSteps(): Promise<void>;
    /** Parse step notification payload. */
    parse(raw: Uint8Array): StepData;
}
