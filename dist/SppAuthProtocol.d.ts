export interface AuthKeys {
    decKey: Uint8Array;
    encKey: Uint8Array;
    decNonce: Uint8Array;
    encNonce: Uint8Array;
}
export declare class SppAuthProtocol {
    private longTermKey;
    private _phoneNonce;
    private _watchNonce;
    private _keys;
    private _authenticated;
    get authenticated(): boolean;
    get keys(): AuthKeys | null;
    constructor(longTermKey: Uint8Array);
    /**
     * Step 1: Generate phone nonce -> encode as Command protobuf
     */
    buildPhoneNonce(): {
        nonce: Uint8Array;
        packet: Uint8Array;
    };
    /**
     * Step 2: Process WatchNonce response from band
     */
    processWatchNonce(watchPayload: Uint8Array): Promise<{
        watchNonce: Uint8Array;
        hmac: Uint8Array;
        authStep3Packet: Uint8Array;
    } | null>;
    /**
     * Step 3: Process auth response (status check)
     */
    processAuthResponse(authPayload: Uint8Array): boolean;
    encryptV2(plaintext: Uint8Array): Uint8Array;
    decryptV2(ciphertext: Uint8Array): Uint8Array;
    reset(): void;
}
