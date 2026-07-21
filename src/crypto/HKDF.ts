// HKDF-HMAC-SHA256 implementation using Web Crypto API
// Protocol: Extract-then-Expand with info = "miwear-auth"

import {
  SESSION_KEY_LENGTH,
} from '../types.js';

export class HKDF {
  /**
   * HKDF-HMAC-SHA256 full pipeline.
   *
   * @param ikm  Input Keying Material (longTermKey)
   * @param salt Optional salt (phoneNonce || bandNonce)
   * @param info Context info ("miwear-auth")
   * @returns    64 bytes of derived key material
   */
  static async derive(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
  ): Promise<Uint8Array> {
    const prk = await this.extract(ikm, salt);
    return await this.expand(prk, info, SESSION_KEY_LENGTH);
  }

  // ── HKDF-Extract: HMAC-SHA256(salt, ikm) → PRK ──
  private static async extract(
    ikm: Uint8Array,
    salt: Uint8Array,
  ): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      'raw',
      salt,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(
      await crypto.subtle.sign('HMAC', key, ikm),
    );
  }

  // ── HKDF-Expand: PRK + info + counter → output ──
  private static async expand(
    prk: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      'raw',
      prk,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const blockSize = 32; // SHA-256 output
    const n = Math.ceil(length / blockSize);
    const result = new Uint8Array(length);
    let prev = new Uint8Array(0);

    for (let i = 1; i <= n; i++) {
      const data = new Uint8Array(prev.length + info.length + 1);
      data.set(prev);
      data.set(info, prev.length);
      data[data.length - 1] = i;

      prev = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, data),
      );
      const offset = (i - 1) * blockSize;
      const toCopy = Math.min(blockSize, length - offset);
      result.set(prev.subarray(0, toCopy), offset);
    }

    return result;
  }
}
