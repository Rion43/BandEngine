export declare const toHex: (bytes: Uint8Array) => string;
export declare function computeAuthStep3Hmac(secretKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array): Promise<Uint8Array>;
export { aesCcmEncrypt } from './aes-ccm.js';
export declare function aesCtrEncrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
export declare const aesCtrDecrypt: typeof aesCtrEncrypt;
export declare function verifyWatchHmac(decKey: Uint8Array, watchNonce: Uint8Array, phoneNonce: Uint8Array, receivedHmac: Uint8Array): Promise<boolean>;
export declare function computeEncryptedNonces(encKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array): Promise<Uint8Array>;
