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

// Manual AES-CTR using @noble/ciphers AES-ECB
// Java Gadgetbridge: cipher.init(op, key, IvParameterSpec(key))
// key = encKey (16B), iv = encKey (16B) -> counter block = key
// Her block: keystream = AES_ECB_encrypt(key, counter)
// XOR ile plaintext -> ciphertext
// Counter 128-bit big-endian artar
import { ecb } from '@noble/ciphers/aes';

export function aesCtrEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = ecb(key);
  const BLOCK = 16;
  const counter = key.slice(); // initial counter = key (Gadgetbridge IvParameterSpec(key))
  const out = new Uint8Array(data.length);

  for (let off = 0; off < data.length; off += BLOCK) {
    const ks = cipher.encrypt(counter);
    const end = Math.min(off + BLOCK, data.length);
    for (let i = off; i < end; i++) out[i] = data[i] ^ ks[i - off];
    // counter++ (128-bit big-endian)
    for (let i = BLOCK - 1; i >= 0; i--) {
      counter[i]++;
      if (counter[i] !== 0 || i === 0) break;
    }
  }
  return out;
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