// SppAuthCrypto — Gadgetbridge-style auth key derivation

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key.buffer.slice(0) as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data.buffer.slice(0) as ArrayBuffer));
}

const MIWEAR_AUTH = new TextEncoder().encode('miwear-auth');

export async function computeAuthStep3Hmac(
  secretKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array,
): Promise<Uint8Array> {
  const salt = new Uint8Array(phoneNonce.length + watchNonce.length);
  salt.set(phoneNonce);
  salt.set(watchNonce, phoneNonce.length);
  const prk = await hmac(salt, secretKey);

  const out = new Uint8Array(64);
  let prev: Uint8Array = new Uint8Array(0);
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

/** AES-CTR using WebCrypto AES-CBC as ECB (first 16 bytes = ECB for single block) */
async function ecbEncrypt(block: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = new Uint8Array(16);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv.buffer as ArrayBuffer }, k, block.buffer as ArrayBuffer));
  return ct.slice(0, 16); // first 16 bytes = AES-ECB
}

export async function aesCtrEncrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const bs = 16;
  const counter = new Uint8Array(bs);
  counter.set(key, 0);
  const result = new Uint8Array(data.length);
  const aesKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['encrypt']);
  const zeroIv = new Uint8Array(16);
  for (let off = 0; off < data.length; off += bs) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv.buffer as ArrayBuffer }, aesKey, counter.buffer as ArrayBuffer));
    const end = Math.min(off + bs, data.length);
    for (let i = off; i < end; i++) result[i] = data[i] ^ ct[i - off];
    for (let i = bs - 1; i >= 0; i--) { if (++counter[i] !== 0) break; }
  }
  return result;
}
export const aesCtrDecrypt = aesCtrEncrypt;

export async function verifyWatchHmac(
  decKey: Uint8Array, watchNonce: Uint8Array, phoneNonce: Uint8Array, receivedHmac: Uint8Array,
): Promise<boolean> {
  const buf = new Uint8Array(watchNonce.length + phoneNonce.length);
  buf.set(watchNonce);
  buf.set(phoneNonce, watchNonce.length);
  const expected = (await hmac(decKey, buf)).slice(0, 16);
  if (expected.length !== receivedHmac.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= expected[i] ^ receivedHmac[i];
  return d === 0;
}

export async function computeEncryptedNonces(
  encKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(phoneNonce.length + watchNonce.length);
  buf.set(phoneNonce);
  buf.set(watchNonce, phoneNonce.length);
  return hmac(encKey, buf);
}