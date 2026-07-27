// SppAuthCrypto — Gadgetbridge-style auth key derivation
// Uses @noble/hashes + @noble/ciphers (replaces Web Crypto API)
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';
import { aesCtrEncrypt, aesCtrDecrypt, aesCcmEncrypt } from './crypto';

export { aesCtrEncrypt, aesCtrDecrypt, aesCcmEncrypt };

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return hmac(sha256, key, data);
}

const MIWEAR_AUTH = new TextEncoder().encode('miwear-auth');

export async function computeAuthStep3Hmac(
  secretKey: Uint8Array,
  phoneNonce: Uint8Array,
  watchNonce: Uint8Array,
): Promise<Uint8Array> {
  const salt = concatBytes(phoneNonce, watchNonce);
  const prk = await hmacSha256(salt, secretKey);

  const out = new Uint8Array(64);
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= 2; i++) {
    const buf = concatBytes(prev, MIWEAR_AUTH, new Uint8Array([i]));
    const block = await hmacSha256(prk, buf);
    out.set(block.slice(0, 32), (i - 1) * 32);
    prev = block;
  }
  return out;
}

export async function verifyWatchHmac(
  decKey: Uint8Array,
  watchNonce: Uint8Array,
  phoneNonce: Uint8Array,
  receivedHmac: Uint8Array,
): Promise<boolean> {
  const buf = concatBytes(watchNonce, phoneNonce);
  const expected = (await hmacSha256(decKey, buf)).slice(0, 16);
  if (expected.length !== receivedHmac.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= expected[i] ^ receivedHmac[i];
  return d === 0;
}

export async function computeEncryptedNonces(
  encKey: Uint8Array,
  phoneNonce: Uint8Array,
  watchNonce: Uint8Array,
): Promise<Uint8Array> {
  const buf = concatBytes(phoneNonce, watchNonce);
  return hmacSha256(encKey, buf);
}
