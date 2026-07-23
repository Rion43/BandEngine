// HKDF-HMAC-SHA256 using Web Crypto API
import { SESSION_KEY_LENGTH } from '../types.js';
export class HKDF {
    static async derive(ikm, salt, info) {
        const prk = await this.extract(ikm, salt);
        return this.expand(prk, info, SESSION_KEY_LENGTH);
    }
    static async extract(ikm, salt) {
        const key = await crypto.subtle.importKey('raw', salt.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm.buffer));
    }
    static async expand(prk, info, length) {
        const key = await crypto.subtle.importKey('raw', prk.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const blockSize = 32;
        const n = Math.ceil(length / blockSize);
        const result = new Uint8Array(length);
        let prev = new Uint8Array(0);
        for (let i = 1; i <= n; i++) {
            const data = new Uint8Array(prev.length + info.length + 1);
            data.set(prev);
            data.set(info, prev.length);
            data[data.length - 1] = i;
            prev = new Uint8Array(await crypto.subtle.sign('HMAC', key, data.buffer));
            const offset = (i - 1) * blockSize;
            const toCopy = Math.min(blockSize, length - offset);
            result.set(prev.subarray(0, toCopy), offset);
        }
        return result;
    }
}
