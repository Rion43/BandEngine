// AES-128-CTR/NoPadding using Web Crypto API

export class AESCTR {
  static async transform(data: Uint8Array, key: Uint8Array, counter: Uint8Array): Promise<Uint8Array> {
    const k = await crypto.subtle.importKey(
      'raw', key.buffer as ArrayBuffer,
      { name: 'AES-CTR' }, false, ['encrypt', 'decrypt'],
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: counter.buffer as ArrayBuffer, length: 128 },
      k, data.buffer as ArrayBuffer,
    );
    return new Uint8Array(encrypted);
  }
}
