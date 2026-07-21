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
} as const;

export const CATEGORIES = {
  SYSTEM: 1,
  HEALTH: 2,
  ACTIVITY: 3,
  NOTIFICATION: 4,
  DEVICE: 5,
} as const;

export const TRANSPORT_TYPE = {
  PLAINTEXT: 100,
  ENCRYPTED: 101,
} as const;

export const BLE_SERVICES = {
  MI_BAND_SERVICE: '0000fee0-0000-1000-8000-00805f9b34fb',
  WRITE_CHAR: '0000fee1-0000-1000-8000-00805f9b34fb',
  NOTIFY_CHAR: '0000fee2-0000-1000-8000-00805f9b34fb',
  AUTH_SERVICE: '0000fee1-0000-1000-8000-00805f9b34fb',
} as const;

export const SESSION_KEY_LENGTH = 64;
export const AES_KEY_LENGTH = 16;
export const MAC_KEY_LENGTH = 16;
export const COUNTER_LENGTH = 4;
export const NONCE_LENGTH = 16;
export const SIGNATURE_LENGTH = 16;

export interface HandshakeResult {
  phoneNonce: Uint8Array;
  bandNonce: Uint8Array;
  signature: Uint8Array;
  macKey: Uint8Array;
  aesKey: Uint8Array;
  counter: number;
}

export interface BandPacket {
  transportType: number;  // 100 | 101
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
