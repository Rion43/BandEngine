// BluefyDiagnostic — BLE teşhis modu
// Hiçbir auth/AES/SPPv2 koduna dokunmaz, sadece log ekler

export interface DiagState {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  gattConnected: boolean;
  serviceCount: number;
  charCount: number;
  notifyEnabled: boolean;
  writeQueue: number;
  sppBufferSize: number;
  authCompleted: boolean;
  encryptionEnabled: boolean;
  lastSentAt: number;
  lastRecvAt: number;
  lastNotificationAt: number;
  disconnectCount: number;
}

let diag: DiagState = {
  deviceId: '', deviceName: '', connected: false, gattConnected: false,
  serviceCount: 0, charCount: 0, notifyEnabled: false, writeQueue: 0,
  sppBufferSize: 0, authCompleted: false, encryptionEnabled: false,
  lastSentAt: 0, lastRecvAt: 0, lastNotificationAt: 0, disconnectCount: 0,
};

let diagEnabled = false;

export function initDiagnostic() {
  diagEnabled = true;
  diag = { deviceId: '', deviceName: '', connected: false, gattConnected: false,
    serviceCount: 0, charCount: 0, notifyEnabled: false, writeQueue: 0,
    sppBufferSize: 0, authCompleted: false, encryptionEnabled: false,
    lastSentAt: 0, lastRecvAt: 0, lastNotificationAt: 0, disconnectCount: 0 };

  // 2. userAgent
  console.log(`[DIAG] userAgent: ${navigator.userAgent}`);

  // 3. Bluefy tespiti
  const ua = navigator.userAgent;
  const isBluefy = ua.includes('Bluefy') || ua.includes('bluefy');
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  console.log(`[DIAG] Bluefy: ${isBluefy} | Safari: ${isSafari} | iOS: ${isIOS}`);

  // 1. navigator.bluetooth
  if (typeof navigator.bluetooth === 'undefined') {
    console.log(`[DIAG] navigator.bluetooth: UNDEFINED`);
  } else {
    const bt = navigator.bluetooth as any;
    const refDevice = bt.referringDevice;
    console.log(`[DIAG] navigator.bluetooth: available referringDevice=${refDevice?.name ?? 'none'}`);
  }

  return { isBluefy, isSafari, isIOS };
}

export function diagDevice(device: BluetoothDevice) {
  if (!diagEnabled) return;
  diag.deviceId = device.id;
  diag.deviceName = device.name ?? '?';
  diag.gattConnected = device.gatt?.connected ?? false;
  console.log(`[DIAG] BluetoothDevice id=${device.id} name=${device.name} gattConnected=${diag.gattConnected}`);
}

export function diagClear() {
  diag.lastNotificationAt = 0;
}

export function diagDisconnect(deviceName: string) {
  diag.disconnectCount++;
  diag.gattConnected = false;
  console.log(`[DIAG] DISCONNECT #${diag.disconnectCount} name=${deviceName}`);
  console.log(`[DIAG]   authCompleted=${diag.authCompleted} encryptionEnabled=${diag.encryptionEnabled}`);
  console.log(`[DIAG]   lastSent=${diag.lastSentAt ? Date.now() - diag.lastSentAt + 'ms ago' : 'never'}`);
  console.log(`[DIAG]   lastRecv=${diag.lastRecvAt ? Date.now() - diag.lastRecvAt + 'ms ago' : 'never'}`);
  console.log(`[DIAG]   lastNotification=${diag.lastNotificationAt ? Date.now() - diag.lastNotificationAt + 'ms ago' : 'never'}`);
  console.log(`[DIAG]   sppBuffer=${diag.sppBufferSize}B writeQueue=${diag.writeQueue}`);
}

export function diagWrite() {
  diag.lastSentAt = Date.now();
}

export function diagRecv(payload: Uint8Array) {
  diag.lastRecvAt = Date.now();
  diag.sppBufferSize = payload.length;
}

export function diagNotify(char: BluetoothRemoteGATTCharacteristic) {
  diag.lastNotificationAt = Date.now();
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[DIAG:${ts}] notification from ${char.uuid}`);
}

export function diagSetAuthCompleted() {
  diag.authCompleted = true;
}

export function diagSetEncryptionEnabled() {
  diag.encryptionEnabled = true;
}

export function diagSetSppBufferSize(size: number) {
  diag.sppBufferSize = size;
}

export function diagDumpState() {
  console.log(`[DIAG] === STATE DUMP ===`);
  console.log(`[DIAG] device=${diag.deviceName} connected=${diag.gattConnected} auth=${diag.authCompleted} enc=${diag.encryptionEnabled}`);
  console.log(`[DIAG] lastSent=${diag.lastSentAt} lastRecv=${diag.lastRecvAt} lastNotif=${diag.lastNotificationAt}`);
  console.log(`[DIAG] sppBuf=${diag.sppBufferSize} disconnectCount=${diag.disconnectCount}`);
  console.log(`[DIAG] === END DUMP ===`);
}

export function diagStartConnect() {
  console.log(`[DIAG] connect() START`);
}

export function diagEndConnect() {
  console.log(`[DIAG] connect() END`);
}

export function diagGetPrimaryService(uuid: string) {
  console.log(`[DIAG] getPrimaryService: ${uuid}`);
}

export function diagGetCharacteristics() {
  console.log(`[DIAG] getCharacteristics()`);
}

export function diagCharacteristics(chars: BluetoothRemoteGATTCharacteristic[]) {
  diag.charCount = chars.length;
  for (const c of chars) {
    const uuid = c.uuid.toLowerCase();
    const p = c.properties;
    console.log(`[DIAG]   char ${uuid} R=${p.read} W=${p.write} WW=${p.writeWithoutResponse} N=${p.notify} I=${p.indicate}`);
  }
}

export function diagStartNotifications(uuid: string) {
  console.log(`[DIAG] startNotifications: ${uuid}`);
}

export function diagStartNotificationsResult(uuid: string, ok: boolean) {
  diag.notifyEnabled = ok;
  console.log(`[DIAG] startNotifications ${uuid}: ${ok ? 'OK' : 'FAIL'}`);
}

export function diagWritePre(desc: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[DIAG:${ts}] write ${desc} BEFORE`);
}

export function diagWritePost(desc: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[DIAG:${ts}] write ${desc} AFTER`);
}

export function diagError(context: string, err: any) {
  try {
    const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
    console.log(`[DIAG] ERROR ${context}: ${err?.message ?? err} | JSON: ${json}`);
  } catch {
    console.log(`[DIAG] ERROR ${context}: ${err?.message ?? err}`);
  }
}
