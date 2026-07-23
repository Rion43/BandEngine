export declare class HKDF {
    static derive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array>;
    private static extract;
    private static expand;
}
