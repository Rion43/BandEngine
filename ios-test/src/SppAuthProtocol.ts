// SppAuthProtocol — Gadgetbridge-style auth orchestrator for SPPv2
// Ported from original BandEngine — no navigator/DOM deps
// Uses RN polyfilled crypto.getRandomValues via react-native-get-random-values
import 'react-native-get-random-values';
import {
  encodeCommandPhoneNonce,
  encodeCommandAuthStep3,
  encodeAuthDeviceInfo,
  encodeAuthStep3Payload,
  decodeWatchNonce,
  decodeAuthResponse,
  bytesToHex,
} from './SppAuthMessages';
import {
  computeAuthStep3Hmac,
  aesCcmEncrypt,
  aesCtrEncrypt,
  aesCtrDecrypt,
  computeEncryptedNonces,
  verifyWatchHmac,
} from './SppAuthCrypto';

export interface AuthKeys {
  decKey: Uint8Array;
  encKey: Uint8Array;
  decNonce: Uint8Array;
  encNonce: Uint8Array;
}

export class SppAuthProtocol {
  private _phoneNonce: Uint8Array | null = null;
  private _watchNonce: Uint8Array | null = null;
  private _keys: AuthKeys | null = null;
  private _authenticated = false;

  get authenticated(): boolean {
    return this._authenticated;
  }
  get keys(): AuthKeys | null {
    return this._keys;
  }

  constructor(private longTermKey: Uint8Array) {}

  /**
   * Step 1: Generate phone nonce -> encode as Command protobuf
   */
  buildPhoneNonce(): { nonce: Uint8Array; packet: Uint8Array } {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    this._phoneNonce = nonce;
    const packet = encodeCommandPhoneNonce(nonce);
    console.log(`[SppAuthProtocol] PhoneNonce: ${bytesToHex(nonce)}`);
    console.log(
      `[SppAuthProtocol] PhoneNonce packet (${packet.length}B): ${bytesToHex(packet)}`,
    );
    return { nonce, packet };
  }

  /**
   * Step 2: Process WatchNonce response from band
   */
  async processWatchNonce(watchPayload: Uint8Array): Promise<{
    watchNonce: Uint8Array;
    hmac: Uint8Array;
    authStep3Packet: Uint8Array;
  } | null> {
    if (!this._phoneNonce) {
      console.error('[SppAuthProtocol] phoneNonce not generated yet');
      return null;
    }

    const decoded = decodeWatchNonce(watchPayload);
    if (!decoded) {
      console.error('[SppAuthProtocol] Failed to decode WatchNonce');
      return null;
    }

    this._watchNonce = decoded.nonce;

    const derived = await computeAuthStep3Hmac(
      this.longTermKey,
      this._phoneNonce,
      decoded.nonce,
    );

    const decKey = derived.slice(0, 16);
    const encKey = derived.slice(16, 32);
    const decNonce = derived.slice(32, 36);
    const encNonce = derived.slice(36, 40);

    this._keys = { decKey, encKey, decNonce, encNonce };

    // Verify watch HMAC
    const valid = await verifyWatchHmac(
      decKey,
      decoded.nonce,
      this._phoneNonce,
      decoded.hmac,
    );

    // Build encrypted nonces
    const encryptedNonces = await computeEncryptedNonces(
      encKey,
      this._phoneNonce,
      decoded.nonce,
    );

    // AuthDeviceInfo protobuf — no navigator, use sensible defaults
    const apiLevel = 30;
    const phoneName = 'BandEngine-iOS';
    const region = 'US';

    const deviceInfo = encodeAuthDeviceInfo(apiLevel, phoneName, region);

    // AES-CCM encrypt device info
    const encryptedDeviceInfo = await aesCcmEncrypt(
      encKey,
      encNonce,
      deviceInfo,
    );

    // Build AuthStep3
    const authStep3 = encodeAuthStep3Payload(
      encryptedNonces,
      encryptedDeviceInfo,
    );
    const authStep3Packet = encodeCommandAuthStep3(authStep3);

    return {
      watchNonce: decoded.nonce,
      hmac: decoded.hmac,
      authStep3Packet,
    };
  }

  /**
   * Step 3: Process auth response (status check)
   */
  processAuthResponse(authPayload: Uint8Array): boolean {
    const result = decodeAuthResponse(authPayload);
    if (result) {
      if (result.success) {
        this._authenticated = true;
        return true;
      }
    }
    return false;
  }

  async encryptV2(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this._keys) throw new Error('AuthProtocol not initialized');
    return aesCtrEncrypt(plaintext, this._keys.encKey);
  }

  async decryptV2(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this._keys) throw new Error('AuthProtocol not initialized');
    return aesCtrDecrypt(ciphertext, this._keys.decKey);
  }

  reset(): void {
    this._phoneNonce = null;
    this._watchNonce = null;
    this._keys = null;
    this._authenticated = false;
  }
}
