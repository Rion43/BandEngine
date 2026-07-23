// SppAuthCrypto — Gadgetbridge-style auth key derivation
function ab(u8) { return u8.slice().buffer.slice(0); }
export const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
async function hmac(key, data) {
    const k = await crypto.subtle.importKey('raw', ab(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, ab(data)));
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
function buildCcmNonce(encNonce, counter) {
    const n = new Uint8Array(12);
    n.set(encNonce, 0);
    n.set([0, 0, 0, 0], 4);
    new DataView(n.buffer).setUint32(8, counter, true);
    return n;
}
export async function aesCcmEncrypt(key, encNonce, data, counter = 0) {
    const nonce = buildCcmNonce(encNonce, counter);
    const k = await crypto.subtle.importKey('raw', ab(key), { name: 'AES-CCM' }, false, ['encrypt']);
    const enc = await crypto.subtle.encrypt({ name: 'AES-CCM', nonce: ab(nonce), tagLength: 32 }, k, ab(data));
    return new Uint8Array(enc);
}
export async function aesCtrEncrypt(data, key) {
    const k = await crypto.subtle.importKey('raw', ab(key), { name: 'AES-CTR' }, false, ['encrypt', 'decrypt']);
    const enc = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: ab(key), length: 128 }, k, ab(data));
    return new Uint8Array(enc);
}
export const aesCtrDecrypt = aesCtrEncrypt;
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
