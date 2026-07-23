// AES-CCM using asmcrypto.js (Bouncy Castle-compatible)
// Gadgetbridge uses Bouncy Castle CCMBlockCipher with macSize=32, nonce=12B

// @ts-ignore - types not resolving with bundler mode
import * as AsmCrypto from 'asmcrypto.js';

const CCM: any = AsmCrypto?.AES_CCM;

if (!CCM || typeof CCM.encrypt !== 'function') {
  throw new Error('AES-CCM: asmcrypto.js AES_CCM not found');
}

/**
 * AES-CCM encrypt (Gadgetbridge Bouncy Castle-compatible).
 * @param key   16-byte AES key
 * @param encNonce 4-byte encNonce (extended to 12 bytes: encNonce || 0x00000000 || LE32(counter))
 * @param data  plaintext
 * @param counter counter value (default 0)
 * @returns ciphertext + 4-byte MAC tag
 */
export function aesCcmEncrypt(
  key: Uint8Array, encNonce: Uint8Array, data: Uint8Array, counter = 0,
): Uint8Array {
  // Build 12-byte nonce (Gadgetbridge birebir)
  const nonce = new Uint8Array(12);
  nonce.set(encNonce, 0);
  nonce.set([0, 0, 0, 0], 4);
  new DataView(nonce.buffer).setUint32(8, counter, true);

  try {
    const result = CCM.encrypt(data, key, nonce, undefined, 4);
    return new Uint8Array(result);
  } catch (e) {
    console.error('[AES-CCM] encrypt failed:', e);
    throw e;
  }
}
