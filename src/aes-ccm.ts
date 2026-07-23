// AES-CCM pure JS implementation using @noble/ciphers (RFC 3610)
// keySize=128, nonce=12B, tagLength=4B (32 bits), L=3

import { cbc } from '@noble/ciphers/aes.js';
import { ctr } from '@noble/ciphers/aes.js';

/** B_0 flags = ((M-2)/2)*8 | (L-1). M=macBytes, L=3 */
function b0Flags(macBytes: number): number {
  return ((macBytes - 2) / 2) << 3 | 2; // L-1 = 2
}

/** CTR counter block: flags=2 (L-1), nonce, counter BE */
function ctrBlock(nonce: Uint8Array, count: number): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = 2; // flags = L-1 = 2 (no data auth, just counter)
  b.set(nonce, 1);
  b[13] = (count >> 16) & 0xff;
  b[14] = (count >> 8) & 0xff;
  b[15] = count & 0xff;
  return b;
}

export function aesCcmEncrypt(
  key: Uint8Array, encNonce: Uint8Array, data: Uint8Array, counter = 0,
): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(encNonce, 0);
  nonce.set([0, 0, 0, 0], 4);
  new DataView(nonce.buffer).setUint32(8, counter, true);

  const msgLen = data.length;
  const macBytes = 4;

  // B_0 block: flags || nonce(12) || msgLen(3) BE
  const b0 = new Uint8Array(16);
  b0[0] = b0Flags(macBytes);
  b0.set(nonce, 1);
  b0[13] = (msgLen >> 16) & 0xff;
  b0[14] = (msgLen >> 8) & 0xff;
  b0[15] = msgLen & 0xff;

  // CBC-MAC input: B_0 || data, zero-padded to 16-byte boundary
  const macLen = 16 + msgLen;
  const paddedLen = macLen % 16 === 0 ? macLen : macLen + 16 - (macLen % 16);
  const macInput = new Uint8Array(paddedLen);
  macInput.set(b0, 0);
  macInput.set(data, 16);

  // CBC-MAC: AES-CBC with zero IV, NO padding
  const iv = new Uint8Array(16);
  const cbcCipher = cbc(key, iv, { disablePadding: true });
  const macCiphertext = cbcCipher.encrypt(macInput);
  // Last 16 bytes are the raw MAC (CBC residual)
  const macFull = macCiphertext.slice(-16);
  const mac = macFull.slice(0, macBytes);

  // Encrypt data: AES-CTR with counter=0, keystream
  const ctrCounter = ctrBlock(nonce, 0);
  const keystreamLen = 16 + msgLen; // need S(0) for tag + S(1)+... for data
  const zeroBuf = new Uint8Array(keystreamLen);
  const ks = ctr(key, ctrCounter).encrypt(zeroBuf);

  // XOR data with keystream[16..16+dataLen]
  const encrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) encrypted[i] = data[i] ^ ks[16 + i];

  // XOR mac with keystream[0..3] (first 4 bytes of S(0))
  const encryptedTag = new Uint8Array(macBytes);
  for (let i = 0; i < macBytes; i++) encryptedTag[i] = mac[i] ^ ks[i];

  // Output: encryptedData || encryptedTag
  const out = new Uint8Array(data.length + macBytes);
  out.set(encrypted, 0);
  out.set(encryptedTag, data.length);
  return out;
}
