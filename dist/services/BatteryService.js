// BatteryService — read battery level and charging status
import { OPCODES, CATEGORIES } from '../types.js';
import { ProtoSerializer } from '../ProtoSerializer.js';
export class BatteryService {
    constructor(encoder, decoder, write) {
        this.encoder = encoder;
        this.decoder = decoder;
        this.write = write;
    }
    async getBatteryInfo() {
        // Request battery info  →  band responds on notify
        const pkt = await this.encoder.encode({
            category: CATEGORIES.DEVICE,
            opcode: OPCODES.BATTERY_INFO,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
        // The caller must call this after receiving the notification
        return { level: 0, charging: false }; // placeholder: real parse after notify
    }
    parse(raw) {
        return ProtoSerializer.decodeBatteryInfo(raw);
    }
}
