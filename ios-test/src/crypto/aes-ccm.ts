// AES-CCM using @noble/ciphers raw AES block
// Gadgetbridge/Bouncy Castle compatible: macSize=4, nonce=12B, no associated data
//
// CCM (Counter with CBC-MAC):
//   MAC = CBC-MAC(key, B0 || plaintext)  — first 4 bytes
//   CT  = AES-CTR(key, counter=1) XOR plaintext
//   Tag = MAC XOR AES(key, counter=0)  — per NIST SP 800-38C Sec 6.2
//   Output = CT || Tag
//
// Nonce construction (12 bytes):
//   encNonce(4) || 0x00000000(4) || LE32(counter)(4)
import { unsafe } from '@noble/ciphers/aes.js';

function xor16(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

function aesBlock(key: Uint8Array, block: Uint8Array): void {
  const xk = unsafe.expandKeyLE(key);
  unsafe.encryptBlock(xk, block);
}

function buildCounterBlock(L: number, nonce: Uint8Array, ctrVal: number): Uint8Array {
  const cb = new Uint8Array(16);
  cb.fill(0);
  cb[0] = L - 1;
  cb.set(nonce, 1);
  cb[1 + 12] = (ctrVal >> 8) & 0xff;
  cb[1 + 12 + 1] = ctrVal & 0xff;
  return cb;
}

/**
 * AES-CCM encrypt (Gadgetbridge Bouncy Castle-compatible).
 * @param key       16-byte AES key
 * @param encNonce  4-byte encNonce
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
  const tagLen = 4;
  const L = 2;
  const nonce = new Uint8Array(12);
  nonce.set(encNonce, 0);
  nonce.set([0, 0, 0, 0], 4);
  const view = new DataView(nonce.buffer);
  view.setUint32(8, counter, true);

  // ── 1. CBC-MAC ──
  const flags = (((tagLen - 2) / 2) << 3) | (L - 1);
  const B0 = new Uint8Array(1 + 12 + L);
  B0[0] = flags;
  B0.set(nonce, 1);
  B0.set([(data.length >> 8) & 0xff, data.length & 0xff], 1 + 12);

  const totalLen = B0.length + data.length;
  const blockCount = Math.ceil(totalLen / 16);
  let mac = new Uint8Array(16);

  for (let bi = 0; bi < blockCount; bi++) {
    const block = new Uint8Array(16);
    const srcOff = bi * 16;
    for (let j = 0; j < 16; j++) {
      const srcIdx = srcOff + j;
      if (srcIdx < B0.length) block[j] = B0[srcIdx];
      else if (srcIdx < totalLen) block[j] = data[srcIdx - B0.length];
      else block[j] = 0;
    }
    const xored = xor16(mac, block);
    aesBlock(key, xored);
    mac = new Uint8Array(xored);
  }

  const rawTag = mac.slice(0, tagLen);

  // ── 2. CTR encrypt: counter=1+ for data, counter=0 for tag ──
  const result = new Uint8Array(data.length + tagLen);

  for (let i = 0; i < data.length; i += 16) {
    const cb = buildCounterBlock(L, nonce, (i / 16) + 1);
    aesBlock(key, cb);
    const end = Math.min(i + 16, data.length);
    for (let j = i; j < end; j++) {
      result[j] = data[j] ^ cb[j - i];
    }
  }

  // Encrypt tag with counter=0 keystream (NIST SP 800-38C Sec 6.2)
  const ctr0 = buildCounterBlock(L, nonce, 0);
  aesBlock(key, ctr0);
  const encryptedTag = new Uint8Array(tagLen);
  for (let i = 0; i < tagLen; i++) {
    encryptedTag[i] = rawTag[i] ^ ctr0[i];
  }

  result.set(encryptedTag, data.length);
  return result;
}
