// BandEngine — Xiaomi Smart Band 9 BLE protocol library
// Based on reverse-engineered Mi Fitness app protocol
export const OPCODES = {
    // Auth handshake
    AUTH_INIT: 26,
    AUTH_RESPONSE: 27,
    AUTH_CONFIRM: 28,
    // Heart rate
    HEART_RATE_START: 67,
    HEART_RATE_STOP: 68,
    HEART_RATE_DATA: 53,
    HEART_RATE_SUBSCRIBE: 69,
    HEART_RATE_UNSUBSCRIBE: 70,
    // Battery
    BATTERY_INFO: 12,
    // Steps / Activity
    STEP_DATA: 1,
    ACTIVITY_DATA: 2,
    // Notifications
    NOTIFICATION_PUSH: 41,
    NOTIFICATION_CLEAR: 42,
    // Device info
    DEVICE_INFO: 10,
    DEVICE_NAME: 11,
};
export const CATEGORIES = {
    SYSTEM: 1,
    HEALTH: 2,
    ACTIVITY: 3,
    NOTIFICATION: 4,
    DEVICE: 5,
};
export const TRANSPORT_TYPE = {
    PLAINTEXT: 100,
    ENCRYPTED: 101,
};
export const BLE_SERVICES = {
    MI_BAND_SERVICE: '0000fe95-0000-1000-8000-00805f9b34fb',
    WRITE_CHAR: '0000005f-0000-1000-8000-00805f9b34fb',
    NOTIFY_CHAR: '0000005e-0000-1000-8000-00805f9b34fb',
};
export const SESSION_KEY_LENGTH = 64;
export const AES_KEY_LENGTH = 16;
export const MAC_KEY_LENGTH = 16;
export const COUNTER_LENGTH = 4;
export const NONCE_LENGTH = 16;
export const SIGNATURE_LENGTH = 16;
