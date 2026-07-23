export declare const OPCODES: {
    readonly AUTH_INIT: 26;
    readonly AUTH_RESPONSE: 27;
    readonly AUTH_CONFIRM: 28;
    readonly HEART_RATE_START: 67;
    readonly HEART_RATE_STOP: 68;
    readonly HEART_RATE_DATA: 53;
    readonly HEART_RATE_SUBSCRIBE: 69;
    readonly HEART_RATE_UNSUBSCRIBE: 70;
    readonly BATTERY_INFO: 12;
    readonly STEP_DATA: 1;
    readonly ACTIVITY_DATA: 2;
    readonly NOTIFICATION_PUSH: 41;
    readonly NOTIFICATION_CLEAR: 42;
    readonly DEVICE_INFO: 10;
    readonly DEVICE_NAME: 11;
};
export declare const CATEGORIES: {
    readonly SYSTEM: 1;
    readonly HEALTH: 2;
    readonly ACTIVITY: 3;
    readonly NOTIFICATION: 4;
    readonly DEVICE: 5;
};
export declare const TRANSPORT_TYPE: {
    readonly PLAINTEXT: 100;
    readonly ENCRYPTED: 101;
};
export declare const BLE_SERVICES: {
    readonly MI_BAND_SERVICE: "0000fe95-0000-1000-8000-00805f9b34fb";
    readonly WRITE_CHAR: "0000005f-0000-1000-8000-00805f9b34fb";
    readonly NOTIFY_CHAR: "0000005e-0000-1000-8000-00805f9b34fb";
};
export declare const SESSION_KEY_LENGTH = 64;
export declare const AES_KEY_LENGTH = 16;
export declare const MAC_KEY_LENGTH = 16;
export declare const COUNTER_LENGTH = 4;
export declare const NONCE_LENGTH = 16;
export declare const SIGNATURE_LENGTH = 16;
export interface HandshakeResult {
    phoneNonce: Uint8Array;
    bandNonce: Uint8Array;
    signature: Uint8Array;
    macKey: Uint8Array;
    aesKey: Uint8Array;
    counter: number;
}
export interface BandPacket {
    transportType: number;
    category: number;
    opcode: number;
    payload: Uint8Array;
}
export interface HeartRateSample {
    timestamp: number;
    heartRate: number;
    confidence: number;
}
export interface BatteryInfo {
    level: number;
    charging: boolean;
}
export interface StepData {
    totalSteps: number;
    distance: number;
    calories: number;
}
