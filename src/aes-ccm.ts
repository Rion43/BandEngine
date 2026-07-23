// AES-CCM pure JS implementation using @noble/ciphers (RFC 3610)
// keySize=128, nonce=12B, tagLength=4B (32 bits), L=3

import { cbc } from '@noble/ciphers/aes.js';
import { ctr } from '@noble/ciphers/aes.js';

function buildB0(nonce: Uint8Array, msgLen: number, macBytes: number): Uint8Array {
  const qValue = 15 - nonce.length; // L
  const flags = ((macBytes - 2) / 2) << 3 | (qValue - 1);
  const b = new Uint8Array(16);
  b[0] = flags;
  b.set(nonce, 1);
  b[13] = (msgLen >> 16) & 0xff;
  b[14] = (msgLen >> 8) & 0xff;
  b[15] = msgLen & 0xff;
  return b;
}

function ctrBlock(nonce: Uint8Array, count: number): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = 14;
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
  const qValue = 3;

  // B_0 for CBC-MAC
  const b0 = buildB0(nonce, msgLen, macBytes);

  // Pad data to 16-byte boundary for CBC-MAC
  const paddedLen = 16 + (msgLen % 16 === 0 ? msgLen : msgLen + 16 - (msgLen % 16));
  const macInput = new Uint8Array(paddedLen);
  macInput.set(b0, 0);
  macInput.set(data, 16);

  // CBC-MAC using @noble/ciphers: cbc(key, iv) returns {encrypt, decrypt}
  const iv = new Uint8Array(16);
  const cipher = cbc(key, iv);
  const ct = cipher.encrypt(macInput);
  const mac = ct.slice(0, macBytes);

  // Generate keystream with AES-CTR, counter=0
  const ctr0 = ctrBlock(nonce, 0);
  const zeroPad = new Uint8Array(16 + msgLen);
  const ks = ctr(key, ctr0).encrypt(zeroPad);

  // Encrypt payload: XOR with keystream[16..]
  const encrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) encrypted[i] = data[i] ^ ks[16 + i];

  // Encrypt tag: XOR with keystream[0..3]
  const encryptedTag = new Uint8Array(macBytes);
  for (let i = 0; i < macBytes; i++) encryptedTag[i] = mac[i] ^ ks[i];

  const out = new Uint8Array(data.length + macBytes);
  out.set(encrypted, 0);
  out.set(encryptedTag, data.length);
  return out;
}
