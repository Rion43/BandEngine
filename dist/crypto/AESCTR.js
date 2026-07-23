// AES-128-CTR/NoPadding using Web Crypto API
export class AESCTR {
    static async transform(data, key, counter) {
        const k = await crypto.subtle.importKey('raw', key.buffer, { name: 'AES-CTR' }, false, ['encrypt', 'decrypt']);
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: counter.buffer, length: 128 }, k, data.buffer);
        return new Uint8Array(encrypted);
    }
}
