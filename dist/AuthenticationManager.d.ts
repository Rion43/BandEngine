import { Session } from './Session.js';
export declare class AuthenticationManager {
    private session;
    /** LongTermKey — established during first-ever pairing */
    private longTermKey;
    private encoder;
    private decoder;
    constructor(session: Session, 
    /** LongTermKey — established during first-ever pairing */
    longTermKey: Uint8Array);
    handshake(write: (data: Uint8Array) => Promise<void>, onNotification: () => Promise<Uint8Array>): Promise<void>;
    private buildConfirmPayload;
}
