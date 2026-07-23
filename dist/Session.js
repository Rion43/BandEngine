// Session — manages derived key material and transport state
import { NONCE_LENGTH, MAC_KEY_LENGTH, AES_KEY_LENGTH, } from './types.js';
import { HKDF } from './crypto/HKDF.js';
import { AESCTR } from './crypto/AESCTR.js';
const AUTH_INFO = new TextEncoder().encode('miwear-auth');
export class Session {
    constructor() {
        this._initialized = false;
    }
    get initialized() {
        return this._initialized;
    }
    get macKey() {
        return this.derived.subarray(0, MAC_KEY_LENGTH);
    }
    get aesKey() {
        return this.derived.subarray(MAC_KEY_LENGTH, MAC_KEY_LENGTH + AES_KEY_LENGTH);
    }
    get counter() {
        // Counter is bytes 32-39 of derived; use full 16 bytes as CTR IV
        const iv = new Uint8Array(16);
        iv.set(this.derived.subarray(32, 40), 8); // place 8-byte counter at end of IV
        return iv;
    }
    /**
     * Full handshake derivation from long-term key.
     * HKDF-HMAC-SHA256 extract-then-expand.
     */
    async deriveKeys(longTermKey) {
        if (!this.phoneNonce || !this.bandNonce) {
            throw new Error('Session: phoneNonce and bandNonce required before key derivation');
        }
        const salt = new Uint8Array(NONCE_LENGTH * 2);
        salt.set(this.phoneNonce);
        salt.set(this.bandNonce, NONCE_LENGTH);
        this.derived = await HKDF.derive(longTermKey, salt, AUTH_INFO);
        this._initialized = true;
    }
    /** Encrypt payload with AES-CTR(sessionKey, counterIV) */
    async encrypt(plaintext) {
        if (!this._initialized)
            throw new Error('Session not initialized');
        return AESCTR.transform(plaintext, this.aesKey, this.counter);
    }
    /** Decrypt payload with same AES-CTR session */
    async decrypt(ciphertext) {
        return this.encrypt(ciphertext); // CTR is symmetric
    }
}
