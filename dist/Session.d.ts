export declare class Session {
    /** 64 bytes: [MAC(16) | AES(16) | counter(4) | counter(4) | padding] */
    private derived;
    private _initialized;
    phoneNonce?: Uint8Array;
    bandNonce?: Uint8Array;
    signature?: Uint8Array;
    get initialized(): boolean;
    get macKey(): Uint8Array;
    get aesKey(): Uint8Array;
    get counter(): Uint8Array;
    /**
     * Full handshake derivation from long-term key.
     * HKDF-HMAC-SHA256 extract-then-expand.
     */
    deriveKeys(longTermKey: Uint8Array): Promise<void>;
    /** Encrypt payload with AES-CTR(sessionKey, counterIV) */
    encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
    /** Decrypt payload with same AES-CTR session */
    decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}
