export declare const toHex: (bytes: Uint8Array) => string;
export declare function computeAuthStep3Hmac(secretKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array): Promise<Uint8Array>;
export { aesCcmEncrypt } from './aes-ccm.js';
/** AES-CTR using Web Crypto API (Gadgetbridge birebir).
 *  Gadgetbridge encryptV2: AES/CTR/NoPadding, key=iv, counter 128-bit.
 *  Java: cipher.init(op, key, IvParameterSpec(key)) -> full 16B counter.
 *  Web Crypto: counter=encKey(16B), length=128 -> full 128-bit initial counter.
 *  Her encrypt/decrypt yeni Web Crypto instance -> stateless, Gadgetbridge ile ayni.
 */
export declare function aesCtrEncrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
export declare function aesCtrDecrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
export declare function verifyWatchHmac(decKey: Uint8Array, watchNonce: Uint8Array, phoneNonce: Uint8Array, receivedHmac: Uint8Array): Promise<boolean>;
export declare function computeEncryptedNonces(encKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array): Promise<Uint8Array>;
