import { toHex } from './SppAuthCrypto.js';
export { toHex };
export declare function encodeCommandPhoneNonce(nonce: Uint8Array): Uint8Array;
export interface WatchNonceResult {
    nonce: Uint8Array;
    hmac: Uint8Array;
}
export declare function decodeWatchNonce(payload: Uint8Array): WatchNonceResult | null;
export declare function encodeAuthDeviceInfo(apiLevel: number, phoneName: string, region: string): Uint8Array;
export declare function encodeAuthStep3Payload(encryptedNonces: Uint8Array, encryptedDeviceInfo: Uint8Array): Uint8Array;
export declare function encodeCommandAuthStep3(authStep3: Uint8Array): Uint8Array;
export interface AuthResponse {
    status: number;
    success: boolean;
}
/**
 * Decode auth response from Command payload.
 * Success = subtype=27 (CMD_AUTH) OR auth.status=1 (Gadgetbridge rule)
 */
export declare function decodeAuthResponse(payload: Uint8Array): AuthResponse | null;
