import { BatteryInfo } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
export declare class BatteryService {
    private encoder;
    private decoder;
    private write;
    constructor(encoder: PacketEncoder, decoder: PacketDecoder, write: (data: Uint8Array) => Promise<void>);
    getBatteryInfo(): Promise<BatteryInfo>;
    parse(raw: Uint8Array): BatteryInfo;
}
