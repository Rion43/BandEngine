import { toHex } from './SppAuthCrypto.js';
export { toHex };
export declare function encodeCommandPhoneNonce(nonce: Uint8Array): Uint8Array;
export interface WatchNonceResult {
    nonce: Uint8Array;
    hmac: Uint8Array;
}
/**
 * Decode WatchNonce from a Command protobuf response.
 * Walks: Command.field3(Auth).field31(WatchNonce){nonce, hmac}
 */
export declare function decodeWatchNonce(payload: Uint8Array): WatchNonceResult | null;
export declare function encodeAuthDeviceInfo(apiLevel: number, phoneName: string, region: string): Uint8Array;
export declare function encodeCommandAuthStep3(authStep3: Uint8Array): Uint8Array;
export declare function encodeAuthStep3Payload(encryptedNonces: Uint8Array, encryptedDeviceInfo: Uint8Array): Uint8Array;
export interface AuthResponse {
    status: number;
    success: boolean;
}
export declare function decodeAuthResponse(payload: Uint8Array): AuthResponse | null;
