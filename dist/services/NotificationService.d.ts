import { PacketEncoder } from '../PacketEncoder.js';
import { PacketDecoder } from '../PacketDecoder.js';
export declare class NotificationService {
    private encoder;
    private decoder;
    private write;
    constructor(encoder: PacketEncoder, decoder: PacketDecoder, write: (data: Uint8Array) => Promise<void>);
    /**
     * Push a notification to the band.
     *
     * @param app   App identifier (e.g. "com.whatsapp")
     * @param title Notification title
     * @param body  Notification body text
     */
    push(app: string, title: string, body: string): Promise<void>;
    /** Clear current notification from band display. */
    clear(): Promise<void>;
}
