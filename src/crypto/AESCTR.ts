// AES-128-CTR/NoPadding using Web Crypto API
// Key = sessionKey[0..15], IV/counter = sessionKey[16..31]

export class AESCTR {
  /**
   * Encrypt / decrypt with AES-128-CTR.
   *
   * The Mi Band protocol reuses the same counter for both ops,
   * so CTR mode makes encrypt === decrypt.
   */
  static async transform(
    data: Uint8Array,
    key: Uint8Array,
    counter: Uint8Array,
  ): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-CTR' },
      false,
      ['encrypt', 'decrypt'],
    );

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-CTR',
        counter,
        length: 128,  // full 16-byte counter block
      },
      cryptoKey,
      data,
    );

    return new Uint8Array(encrypted);
  }
}
