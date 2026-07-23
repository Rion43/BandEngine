// AuthenticationManager — handles pairing handshake (opcodes 26-28)
// Flow:
//   1. Phone sends AUTH_INIT(phoneNonce)
//   2. Band replies with AUTH_RESPONSE(bandNonce, signature)
//   3. Phone verifies signature, derives session keys
//   4. Phone sends AUTH_CONFIRM(...) to complete
import { OPCODES, CATEGORIES, NONCE_LENGTH, SIGNATURE_LENGTH, } from './types.js';
import { PacketEncoder } from './PacketEncoder.js';
import { PacketDecoder } from './PacketDecoder.js';
import { ProtoSerializer } from './ProtoSerializer.js';
export class AuthenticationManager {
    constructor(session, 
    /** LongTermKey — established during first-ever pairing */
    longTermKey) {
        this.session = session;
        this.longTermKey = longTermKey;
        this.encoder = new PacketEncoder(session);
        this.decoder = new PacketDecoder(session);
    }
    async handshake(write, onNotification) {
        // ── 1. Send AUTH_INIT with phone nonce ──
        const phoneNonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
        this.session.phoneNonce = phoneNonce;
        const initPayload = ProtoSerializer.encodeHandshakeInit(phoneNonce);
        const initPacket = await this.encoder.encode({
            category: CATEGORIES.SYSTEM,
            opcode: OPCODES.AUTH_INIT,
            payload: initPayload,
        });
        await write(initPacket);
        // ── 2. Receive AUTH_RESPONSE ──
        const rawResponse = await onNotification();
        const response = await this.decoder.decode(rawResponse);
        const { bandNonce, signature } = ProtoSerializer.decodeHandshakeResponse(response.payload);
        this.session.bandNonce = bandNonce;
        this.session.signature = signature;
        // ── 3. Derive session keys ──
        await this.session.deriveKeys(this.longTermKey);
        // ── 4. Send AUTH_CONFIRM ──
        const confirmPayload = await this.buildConfirmPayload();
        const confirmPacket = await this.encoder.encode({
            category: CATEGORIES.SYSTEM,
            opcode: OPCODES.AUTH_CONFIRM,
            payload: confirmPayload,
        });
        await write(confirmPacket);
    }
    async buildConfirmPayload() {
        const macKey = this.session.macKey;
        const data = new Uint8Array(NONCE_LENGTH * 2);
        data.set(this.session.phoneNonce);
        data.set(this.session.bandNonce, NONCE_LENGTH);
        const cryptoKey = await crypto.subtle.importKey('raw', macKey.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data.buffer));
        return sig.subarray(0, SIGNATURE_LENGTH);
    }
}
