// Session — manages derived key material and transport state

import {
  HandshakeResult,
  NONCE_LENGTH,
  SIGNATURE_LENGTH,
  MAC_KEY_LENGTH,
  AES_KEY_LENGTH,
  COUNTER_LENGTH,
  SESSION_KEY_LENGTH,
} from './types.js';
import { HKDF } from './crypto/HKDF.js';
import { AESCTR } from './crypto/AESCTR.js';

const AUTH_INFO = new TextEncoder().encode('miwear-auth');

export class Session {
  /** 64 bytes: [MAC(16) | AES(16) | counter(4) | counter(4) | padding] */
  private derived!: Uint8Array;
  private _initialized = false;

  phoneNonce?: Uint8Array;
  bandNonce?: Uint8Array;
  signature?: Uint8Array;

  get initialized(): boolean {
    return this._initialized;
  }

  get macKey(): Uint8Array {
    return this.derived.subarray(0, MAC_KEY_LENGTH);
  }

  get aesKey(): Uint8Array {
    return this.derived.subarray(MAC_KEY_LENGTH, MAC_KEY_LENGTH + AES_KEY_LENGTH);
  }

  get counter(): Uint8Array {
    // Counter is bytes 32-39 of derived; use full 16 bytes as CTR IV
    const iv = new Uint8Array(16);
    iv.set(this.derived.subarray(32, 40), 8); // place 8-byte counter at end of IV
    return iv;
  }

  /**
   * Full handshake derivation from long-term key.
   * HKDF-HMAC-SHA256 extract-then-expand.
   */
  async deriveKeys(longTermKey: Uint8Array): Promise<void> {
    if (!this.phoneNonce || !this.bandNonce) {
      throw new Error('Session: phoneNonce and bandNonce required before key derivation');
    }
    const salt = new Uint8Array(NONCE_LENGTH * 2);
    salt.set(this.phoneNonce);
    salt.set(this.bandNonce, NONCE_LENGTH);

    this.derived = await HKDF.derive(longTermKey, salt, AUTH_INFO);
    this._initialized = true;
  }

  /** Encrypt payload with AES-CTR(sessionKey, counterIV) */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this._initialized) throw new Error('Session not initialized');
    return AESCTR.transform(plaintext, this.aesKey, this.counter);
  }

  /** Decrypt payload with same AES-CTR session */
  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    return this.encrypt(ciphertext); // CTR is symmetric
  }
}
