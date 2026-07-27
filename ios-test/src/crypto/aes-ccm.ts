// AES-CCM using @noble/ciphers (replaces asmcrypto.js / Bouncy Castle)
// Gadgetbridge-compatible: macSize=4, nonce=12B
import { ccm } from '@noble/ciphers/aes';
import { concatBytes } from '@noble/hashes/utils';

/**
 * AES-CCM encrypt (Gadgetbridge Bouncy Castle-compatible).
 * @param key       16-byte AES key
 * @param encNonce  4-byte encNonce (extended to 12 bytes: encNonce || 0x00000000 || LE32(counter))
 * @param data      plaintext
 * @param counter   counter value (default 0)
 * @returns ciphertext + 4-byte MAC tag
 */
export function aesCcmEncrypt(
  key: Uint8Array,
  encNonce: Uint8Array,
  data: Uint8Array,
  counter = 0,
): Uint8Array {
  // Build 12-byte nonce (Gadgetbridge birebir)
  const nonce = new Uint8Array(12);
  nonce.set(encNonce, 0);
  nonce.set([0, 0, 0, 0], 4);
  const view = new DataView(nonce.buffer);
  view.setUint32(8, counter, true);

  // CCM with 4-byte MAC tag (tagLength=4), no associated data
  const ctx = ccm(key, nonce, undefined, 4);
  return ctx.encrypt(data);
}
