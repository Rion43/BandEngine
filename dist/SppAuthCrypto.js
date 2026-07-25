// SppAuthCrypto — Gadgetbridge-style auth key derivation
export const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
async function hmac(key, data) {
    const k = await crypto.subtle.importKey('raw', key.buffer.slice(0), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data.buffer.slice(0)));
}
const MIWEAR_AUTH = new TextEncoder().encode('miwear-auth');
export async function computeAuthStep3Hmac(secretKey, phoneNonce, watchNonce) {
    const salt = new Uint8Array(phoneNonce.length + watchNonce.length);
    salt.set(phoneNonce);
    salt.set(watchNonce, phoneNonce.length);
    const prk = await hmac(salt, secretKey);
    const out = new Uint8Array(64);
    let prev = new Uint8Array(0);
    for (let i = 1; i <= 2; i++) {
        const buf = new Uint8Array(prev.length + MIWEAR_AUTH.length + 1);
        buf.set(prev);
        buf.set(MIWEAR_AUTH, prev.length);
        buf[buf.length - 1] = i;
        const block = await hmac(prk, buf);
        out.set(block.slice(0, 32), (i - 1) * 32);
        prev = block;
    }
    return out;
}
export { aesCcmEncrypt } from './aes-ccm.js';
// Web Crypto API AES-CTR — Java AES/CTR/NoPadding ile birebir
// Gadgetbridge ctrCrypt: Cipher.getInstance("AES/CTR/NoPadding"), key=iv
// Web Crypto: counter=key(16B), length=128 -> full 128-bit initial counter
// counter block = key (IvParameterSpec ile ayni), big-endian counter increment
export async function aesCtrEncrypt(data, key) {
    const k = await crypto.subtle.importKey('raw', key.slice().buffer, { name: 'AES-CTR' }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: key.slice(), length: 128 }, k, data.slice().buffer);
    return new Uint8Array(ct);
}
export async function aesCtrDecrypt(data, key) {
    const k = await crypto.subtle.importKey('raw', key.slice().buffer, { name: 'AES-CTR' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: key.slice(), length: 128 }, k, data.slice().buffer);
    return new Uint8Array(pt);
}
export async function verifyWatchHmac(decKey, watchNonce, phoneNonce, receivedHmac) {
    const buf = new Uint8Array(watchNonce.length + phoneNonce.length);
    buf.set(watchNonce);
    buf.set(phoneNonce, watchNonce.length);
    const expected = (await hmac(decKey, buf)).slice(0, 16);
    if (expected.length !== receivedHmac.length)
        return false;
    let d = 0;
    for (let i = 0; i < expected.length; i++)
        d |= expected[i] ^ receivedHmac[i];
    return d === 0;
}
export async function computeEncryptedNonces(encKey, phoneNonce, watchNonce) {
    const buf = new Uint8Array(phoneNonce.length + watchNonce.length);
    buf.set(phoneNonce);
    buf.set(watchNonce, phoneNonce.length);
    return hmac(encKey, buf);
}
