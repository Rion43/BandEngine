// SppAuthProtocol — Gadgetbridge-style auth orchestrator for SPPv2
// Flow:
//   1. PhoneNonce (CMD_NONCE=26) -> wait for WatchNonce response
//   2. Verify HMAC, derive keys
//   3. AuthStep3 (CMD_AUTH=27) -> wait for auth status
//   4. Encryption enabled

import {
  encodeCommandPhoneNonce,
  encodeCommandAuthStep3,
  encodeAuthDeviceInfo,
  encodeAuthStep3Payload,
  decodeWatchNonce,
  decodeAuthResponse,
  toHex as msgHex,
} from './SppAuthMessages.js';
import {
  computeAuthStep3Hmac,
  aesCcmEncrypt,
  aesCtrEncrypt,
  aesCtrDecrypt,
  computeEncryptedNonces,
  verifyWatchHmac,
  toHex as cryHex,
} from './SppAuthCrypto.js';

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
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    this._phoneNonce = nonce;
    const packet = encodeCommandPhoneNonce(nonce);
    console.log(`[SppAuthProtocol] PhoneNonce: ${msgHex(nonce)}`);
    console.log(`[SppAuthProtocol] PhoneNonce packet (${packet.length}B): ${msgHex(packet)}`);
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

    console.log(`[SppAuthProtocol] WatchNonce raw payload (${watchPayload.length}B): ${msgHex(watchPayload)}`);

    const decoded = decodeWatchNonce(watchPayload);
    if (!decoded) {
      console.error('[SppAuthProtocol] Failed to decode WatchNonce from payload');
      return null;
    }

    this._watchNonce = decoded.nonce;
    console.log(`[SppAuthProtocol] WatchNonce nonce (${decoded.nonce.length}B): ${msgHex(decoded.nonce)}`);
    console.log(`[SppAuthProtocol] WatchNonce hmac (${decoded.hmac.length}B): ${msgHex(decoded.hmac)}`);

    // Derive keys
    const derived = await computeAuthStep3Hmac(this.longTermKey, this._phoneNonce, decoded.nonce);

    const decKey = derived.slice(0, 16);
    const encKey = derived.slice(16, 32);
    const decNonce = derived.slice(32, 36);
    const encNonce = derived.slice(36, 40);

    this._keys = { decKey, encKey, decNonce, encNonce };

    console.log(`[SppAuthProtocol] Derived keys (64B total):`);
    console.log(`[SppAuthProtocol]   decKey(16):  ${msgHex(decKey)}`);
    console.log(`[SppAuthProtocol]   encKey(16):  ${msgHex(encKey)}`);
    console.log(`[SppAuthProtocol]   decNonce(4): ${msgHex(decNonce)}`);
    console.log(`[SppAuthProtocol]   encNonce(4): ${msgHex(encNonce)}`);

    // Verify watch HMAC: HMAC-SHA256(decKey, watchNonce||phoneNonce)[0:16]
    const valid = await verifyWatchHmac(decKey, decoded.nonce, this._phoneNonce, decoded.hmac);
    console.log(`[SppAuthProtocol] HMAC verification: ${valid ? '✓ PASS' : '✗ FAIL'}`);

    // Build encrypted nonces (HMAC-SHA256 of phoneNonce||watchNonce with encKey)
    const encryptedNonces = await computeEncryptedNonces(encKey, this._phoneNonce, decoded.nonce);
    console.log(`[SppAuthProtocol] encryptedNonces (encKey HMAC, 32B): ${msgHex(encryptedNonces)}`);

    // AuthDeviceInfo protobuf
    const apiLevel = typeof navigator !== 'undefined'
      ? parseInt((navigator as any).userAgentData?.platformVersion ?? '30') || 30
      : 30;
    const phoneName = typeof navigator !== 'undefined' ? (navigator.userAgent || 'BandEngine') : 'BandEngine';
    const region = 'TR';

    const deviceInfo = encodeAuthDeviceInfo(apiLevel, phoneName, region);
    console.log(`[SppAuthProtocol] DeviceInfo plaintext (${deviceInfo.length}B): ${msgHex(deviceInfo)}`);

    // AES-CCM encrypt device info with encKey + encNonce
    const encryptedDeviceInfo = await aesCcmEncrypt(encKey, encNonce, deviceInfo);
    console.log(`[SppAuthProtocol] encryptedDeviceInfo (${encryptedDeviceInfo.length}B): ${msgHex(encryptedDeviceInfo)}`);

    // Build AuthStep3 inner payload
    const authStep3 = encodeAuthStep3Payload(encryptedNonces, encryptedDeviceInfo);
    console.log(`[SppAuthProtocol] AuthStep3 payload (${authStep3.length}B): ${msgHex(authStep3)}`);

    // Wrap in Command{type=1, subtype=27}
    const authStep3Packet = encodeCommandAuthStep3(authStep3);
    console.log(`[SppAuthProtocol] AuthStep3 final packet (${authStep3Packet.length}B): ${msgHex(authStep3Packet)}`);

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
    console.log(`[SppAuthProtocol] Auth response payload (${authPayload.length}B): ${msgHex(authPayload)}`);

    const result = decodeAuthResponse(authPayload);
    if (result) {
      console.log(`[SppAuthProtocol] Auth response: status=${result.status}, success=${result.success}`);
      if (result.success) {
        this._authenticated = true;
        return true;
      }
    } else {
      console.warn('[SppAuthProtocol] Could not parse auth response');
    }
    return false;
  }

  // ── Encryption helpers (V2 Gadgetbridge style: AES-CTR with key-as-IV) ──

  async encryptV2(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this._keys) throw new Error('AuthProtocol not initialized');
    console.log(`[SppAuthProtocol] encryptV2: ${msgHex(plaintext)}`);
    return aesCtrEncrypt(plaintext, this._keys.encKey);
  }

  async decryptV2(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this._keys) throw new Error('AuthProtocol not initialized');
    console.log(`[SppAuthProtocol] decryptV2: ${msgHex(ciphertext)}`);
    return aesCtrDecrypt(ciphertext, this._keys.decKey);
  }

  reset(): void {
    this._phoneNonce = null;
    this._watchNonce = null;
    this._keys = null;
    this._authenticated = false;
  }
}
