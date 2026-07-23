// HKDF-HMAC-SHA256 using Web Crypto API

import { SESSION_KEY_LENGTH } from '../types.js';

export class HKDF {
  static async derive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
    const prk = await this.extract(ikm, salt);
    return this.expand(prk, info, SESSION_KEY_LENGTH);
  }

  private static async extract(ikm: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', salt.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm.buffer as ArrayBuffer));
  }

  private static async expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', prk.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const blockSize = 32;
    const n = Math.ceil(length / blockSize);
    const result = new Uint8Array(length);
    let prev = new Uint8Array(0);

    for (let i = 1; i <= n; i++) {
      const data = new Uint8Array(prev.length + info.length + 1);
      data.set(prev);
      data.set(info, prev.length);
      data[data.length - 1] = i;
      prev = new Uint8Array(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));
      const offset = (i - 1) * blockSize;
      const toCopy = Math.min(blockSize, length - offset);
      result.set(prev.subarray(0, toCopy), offset);
    }
    return result;
  }
}
