// BatteryService — read battery level and charging status

import { OPCODES, CATEGORIES, BatteryInfo } from '../types.js';
import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
import { ProtoSerializer } from '../ProtoSerializer.js';

export class BatteryService {
  constructor(
    private encoder: PacketEncoder,
    private decoder: PacketDecoder,
    private write: (data: Uint8Array) => Promise<void>,
  ) {}

  async getBatteryInfo(): Promise<BatteryInfo> {
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

  parse(raw: Uint8Array): BatteryInfo {
    return ProtoSerializer.decodeBatteryInfo(raw);
  }
}
