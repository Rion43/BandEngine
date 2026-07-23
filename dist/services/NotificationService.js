// NotificationService — push phone notifications to the band
import { OPCODES, CATEGORIES } from '../types.js';
import { ProtoSerializer } from '../ProtoSerializer.js';
export class NotificationService {
    constructor(encoder, decoder, write) {
        this.encoder = encoder;
        this.decoder = decoder;
        this.write = write;
    }
    /**
     * Push a notification to the band.
     *
     * @param app   App identifier (e.g. "com.whatsapp")
     * @param title Notification title
     * @param body  Notification body text
     */
    async push(app, title, body) {
        const payload = ProtoSerializer.encodeNotification(app, title, body);
        const pkt = await this.encoder.encode({
            category: CATEGORIES.NOTIFICATION,
            opcode: OPCODES.NOTIFICATION_PUSH,
            payload,
        });
        await this.write(pkt);
    }
    /** Clear current notification from band display. */
    async clear() {
        const pkt = await this.encoder.encode({
            category: CATEGORIES.NOTIFICATION,
            opcode: OPCODES.NOTIFICATION_CLEAR,
            payload: new Uint8Array(),
        });
        await this.write(pkt);
    }
}
