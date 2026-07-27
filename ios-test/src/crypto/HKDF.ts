// HKDF-HMAC-SHA256 using @noble/hashes (replaces Web Crypto API)
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, createView } from '@noble/hashes/utils';

const BLOCK_SIZE = 32; // SHA-256 output length
const SESSION_KEY_LENGTH = 64;

export class HKDF {
  static derive(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
  ): Uint8Array {
    const prk = this.extract(ikm, salt);
    return this.expand(prk, info, SESSION_KEY_LENGTH);
  }

  private static extract(ikm: Uint8Array, salt: Uint8Array): Uint8Array {
    // HMAC-SHA256(salt, ikm)
    return hmac(sha256, salt, ikm);
  }

  private static expand(
    prk: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Uint8Array {
    const n = Math.ceil(length / BLOCK_SIZE);
    const blocks: Uint8Array[] = [];
    let prev = new Uint8Array(0);

    for (let i = 1; i <= n; i++) {
      const data = concatBytes(prev, info, new Uint8Array([i]));
      prev = hmac(sha256, prk, data);
      blocks.push(prev);
    }

    const result = concatBytes(...blocks);
    return result.slice(0, length);
  }
}
