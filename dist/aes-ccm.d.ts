/**
 * AES-CCM encrypt (Gadgetbridge Bouncy Castle-compatible).
 * @param key   16-byte AES key
 * @param encNonce 4-byte encNonce (extended to 12 bytes: encNonce || 0x00000000 || LE32(counter))
 * @param data  plaintext
 * @param counter counter value (default 0)
 * @returns ciphertext + 4-byte MAC tag
 */
export declare function aesCcmEncrypt(key: Uint8Array, encNonce: Uint8Array, data: Uint8Array, counter?: number): Uint8Array;
