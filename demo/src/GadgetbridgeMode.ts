// GadgetbridgeMode — Xiaomi Band 9 Gadgetbridge baglanti akisi, birebir
// Kaynak kod satirlari her fonksiyonda belirtilmistir.
//
// Ana akis:
//   BtLEQueue.connect() -> initializeDevice() -> SessionConfig
//   -> processPacket -> startEncryptedHandshake()
//   -> PhoneNonce -> WatchNonce -> AuthStep3 -> AuthSuccess
//   -> onAuthSuccess() -> Clock + mServiceMap.initialize()
//   -> handleDisconnected -> autoReconnect

import { log, hex as hexLog } from './logger.js';
import { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode, SessionConfigOpcode } from '../../src/SppPacketV2.js';
import { SppAuthProtocol } from '../../src/SppAuthProtocol.js';
import { toHex } from '../../src/SppAuthMessages.js';
import { encodeCommandClock } from '../../src/SppSystemMessages.js';

// ── GBDevice.State (GB AbstractBTLESingleDeviceSupport) ──
const State = { NONE: 0, INITIALIZING: 1, AUTHENTICATING: 2, INITIALIZED: 3, CONNECTED: 4, NOT_CONNECTED: 5, WAITING_FOR_RECONNECT: 6 };

// ── GB handleDisconnected status kodlari (BtLEQueue.java:421-435) ──
function isForceDisconnectStatus(status: number): boolean {
  return status === 0x81 || status === 0x85 || status === 0x08 || status === 0x93;
}

// ── GB mServiceMap initialize sirasi (XiaomiSupport.java:92-105) ──
//   Her service.initialize() icinde kendi sendCommand'lari
//   Gadgetbridge'de COMMAND_TYPE her service'in kendi sabiti
const SERVICE_INIT: { type: number; name: string; commands: { subtype: number; desc: string }[] }[] = [
  // XiaomiAuthService (COMMAND_TYPE=1): initialize() BOS
  // XiaomiMusicService (COMMAND_TYPE=18): initialize() BOS
  // XiaomiHealthService (COMMAND_TYPE=8): setUserInfo + 7 config GET (HealthService.java:195-208)
  { type: 8, name: 'HealthService.initialize', commands: [
    { subtype: 0, desc: 'CMD_SET_USER_INFO' },
    { subtype: 8, desc: 'CMD_CONFIG_SPO2_GET' },
    { subtype: 10, desc: 'CMD_CONFIG_HEART_RATE_GET' },
    { subtype: 12, desc: 'CMD_CONFIG_STANDING_REMINDER_GET' },
    { subtype: 14, desc: 'CMD_CONFIG_STRESS_GET' },
    { subtype: 21, desc: 'CMD_CONFIG_GOAL_NOTIFICATION_GET' },
    { subtype: 42, desc: 'CMD_CONFIG_GOALS_GET' },
    { subtype: 35, desc: 'CMD_CONFIG_VITALITY_SCORE_GET' },
  ]},
  // XiaomiNotificationService (COMMAND_TYPE=7): screenOn + canned messages (NotificationService.java:94-99)
  { type: 7, name: 'NotificationService.initialize', commands: [
    { subtype: 0, desc: 'CMD_SCREEN_ON_ON_NOTIFICATIONS_GET' },
  ]},
  // XiaomiScheduleService (COMMAND_TYPE=17): alarms+reminders+worldClocks (ScheduleService.java:147-156)
  { type: 17, name: 'ScheduleService.initialize', commands: [
    { subtype: 61, desc: 'CMD_ALARM_GET' },
    { subtype: 64, desc: 'CMD_REMINDER_GET' },
    { subtype: 68, desc: 'CMD_WORLD_CLOCK_GET' },
  ]},
  // XiaomiWeatherService (COMMAND_TYPE=10): setMeasurementSystem + getLocations (WeatherService.java:77-80)
  { type: 10, name: 'WeatherService.initialize', commands: [
    { subtype: 0, desc: 'CMD_GET_LOCATIONS' },
  ]},
  // XiaomiSystemService (COMMAND_TYPE=2): 9 GET (SystemService.java:123-143)
  { type: 2, name: 'SystemService.initialize', commands: [
    { subtype: 2, desc: 'CMD_DEVICE_INFO' },
    { subtype: 78, desc: 'CMD_DEVICE_STATE_GET' },
    { subtype: 1, desc: 'CMD_BATTERY' },
    { subtype: 9, desc: 'CMD_PASSWORD_GET' },
    { subtype: 29, desc: 'CMD_DISPLAY_ITEMS_GET' },
    { subtype: 7, desc: 'CMD_CAMERA_REMOTE_GET' },
    { subtype: 51, desc: 'CMD_WIDGET_SCREENS_GET' },
    { subtype: 53, desc: 'CMD_WIDGET_PARTS_GET' },
    { subtype: 39, desc: 'CMD_WORKOUT_TYPES_GET' },
  ]},
  // XiaomiCalendarService (COMMAND_TYPE=12): syncCalendar (CalendarService.java:59-61)
  { type: 12, name: 'CalendarService.initialize', commands: [
    { subtype: 0, desc: 'CMD_SYNC_CALENDAR' },
  ]},
  // XiaomiWatchfaceService (COMMAND_TYPE=4): initialize() BOS (state reset)
  // XiaomiDataUploadService (COMMAND_TYPE=22): initialize() BOS
  // XiaomiPhonebookService (COMMAND_TYPE=21): initialize() BOS
  // XiaomiRpkService (COMMAND_TYPE=20): initialize() BOS
];

// ── GBDeviceHandle: XiaomiSupport + XiaomiBleProtocolV2 + BtLEQueue state ──
export class GBDeviceHandle {
  // BtLEQueue (BtLEQueue.java:73-101)
  device: BluetoothDevice | null = null;
  gattServer: BluetoothRemoteGATTServer | null = null;
  mBluetoothGatt: BluetoothRemoteGATTServer | null = null; // GB naming
  btCharacteristicRead: BluetoothRemoteGATTCharacteristic | null = null;  // 005E
  btCharacteristicWrite: BluetoothRemoteGATTCharacteristic | null = null; // 005F
  connected = false;
  state = State.NONE;
  autoReconnect = true;     // GB: useAutoConnect() = true, setAutoReconnect(true)

  // XiaomiBleProtocolV2 (BleProtocolV2.java:43-50)
  packetSequenceCounter = 0;
  maxWriteSize = 244;
  buffer = new Uint8Array();       // ByteArrayOutputStream

  // XiaomiAuthService (AuthService.java:60-78)
  authProtocol: SppAuthProtocol | null = null;
  encryptionInitialized = false;
  secretKey = new Uint8Array(16);
  nonce = new Uint8Array(16);
  decryptionKey = new Uint8Array(16);
  encryptionKey = new Uint8Array(16);
  decryptionNonce = new Uint8Array(4);
  encryptionNonce = new Uint8Array(4);

  // Notification queue (GB: onCharacteristicChanged -> buffer)
  notifyQueue: Uint8Array[] = [];
  notifyResolve: ((d: Uint8Array) => void) | null = null;
  authResolve: ((d: Uint8Array | null) => void) | null = null;
}

// ═══════════════════════════════════════════════════════════════════
// GB: BtLEQueue.connect() -> connectImp() -> gatt.connect()
//   BtLEQueue.java:292-368
// ═══════════════════════════════════════════════════════════════════
async function gattConnect(handle: GBDeviceHandle): Promise<void> {
  // GB: synchronized(mGattMonitor) (BtLEQueue.java:293)
  if (handle.state >= State.INITIALIZING) {
    log('warn', '[GB] connect ignored, state=' + handle.state);
    return;
  }

  // GB: connectImp() (324-367)
  //   cancelDiscovery + getRemoteDevice + connectGatt
  handle.gattServer = await handle.device!.gatt!.connect();

  // GB: onConnectionStateChange -> STATE_CONNECTED (BtLEQueue.java:638-661)
  //   -> cached services check -> discoverServices
  handle.connected = true;
  handle.state = State.CONNECTED;

  // GB: gatt.getServices() -> cached? -> discoverServices
  // Web Bluetooth: getPrimaryService otomatik service discovery yapar
  const service = await handle.gattServer.getPrimaryService('0000fe95-0000-1000-8000-00805f9b34fb');
  const chars = await service.getCharacteristics();
  handle.btCharacteristicRead = chars.find(c => c.uuid.toLowerCase().includes('005e')) ?? null;
  handle.btCharacteristicWrite = chars.find(c => c.uuid.toLowerCase().includes('005f')) ?? null;
  if (!handle.btCharacteristicRead || !handle.btCharacteristicWrite) throw new Error('005E/005F not found');

  log('info', `[GB] W=${handle.btCharacteristicWrite.uuid} N=${handle.btCharacteristicRead.uuid}`);
}

// ═══════════════════════════════════════════════════════════════════
// GB: enable notification
//   XiaomiBleProtocolV2.initializeDevice() -> builder.notify(char, true)
// ═══════════════════════════════════════════════════════════════════
async function enableNotifications(handle: GBDeviceHandle): Promise<void> {
  handle.btCharacteristicRead!.addEventListener('characteristicvaluechanged', (ev: Event) => {
    const target = ev.target as unknown as BluetoothRemoteGATTCharacteristic;
    const value = new Uint8Array(target.value!.buffer);
    gattOnCharacteristicChanged(handle, value);
  });
  await handle.btCharacteristicRead!.startNotifications();
  log('info', '[GB] Notifications enabled');
}

// ═══════════════════════════════════════════════════════════════════
// GB: onCharacteristicChanged (BleProtocolV2.java:110-127)
//   -> buffer.write(value) -> processBuffer()
// ═══════════════════════════════════════════════════════════════════
function gattOnCharacteristicChanged(handle: GBDeviceHandle, value: Uint8Array) {
  // GB: buffer.write(value) (BleProtocolV2.java:117)
  const merged = new Uint8Array(handle.buffer.length + value.length);
  merged.set(handle.buffer);
  merged.set(value, handle.buffer.length);
  handle.buffer = merged;

  // GB: processBuffer() (144-175)
  processBuffer(handle);

  // For async waiters
  if (handle.notifyResolve) {
    handle.notifyResolve(value);
    handle.notifyResolve = null;
  } else {
    handle.notifyQueue.push(value);
  }
}

// ═══════════════════════════════════════════════════════════════════
// GB: processBuffer (BleProtocolV2.java:144-175)
//   while loop -> processPacket -> skip/preserve bytes
// ═══════════════════════════════════════════════════════════════════
function processBuffer(handle: GBDeviceHandle) {
  let shouldProcess = true;
  while (shouldProcess) {
    const buf = handle.buffer;
    // GB: processPacket returns ParseResult{status, packetSize} (279-339)
    const result = processPacket(handle, buf);
    let skipBytes = 0;

    switch (result.status) {
      case 'incomplete': skipBytes = 0; shouldProcess = false; break;
      case 'complete': skipBytes = result.packetSize; break;
      case 'invalid':
        // GB: findNextPacketOffset -> sadece 0xA5 ara (270-277)
        skipBytes = -1;
        for (let i = 1; i < buf.length; i++) { if (buf[i] === 0xa5) { skipBytes = i; break; } }
        if (skipBytes < 0) skipBytes = buf.length;
        break;
    }

    if (skipBytes > 0) {
      if (skipBytes >= buf.length) { handle.buffer = new Uint8Array(); }
      else { handle.buffer = buf.slice(skipBytes); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// GB: processPacket (BleProtocolV2.java:279-339)
//   XiaomiSppPacketV2.decode -> switch(packetType)
//   SESSION_CONFIG -> startEncryptedHandshake
//   DATA -> onPacketReceived -> sendAck
// ═══════════════════════════════════════════════════════════════════
function processPacket(handle: GBDeviceHandle, rxBuf: Uint8Array): { status: string; packetSize: number } {
  // GB: min 8 byte (279-285)
  if (rxBuf.length < 8) return { status: 'incomplete', packetSize: 0 };

  // GB: preamble check (287-296)
  if (rxBuf[0] !== 0xa5 || rxBuf[1] !== 0xa5) return { status: 'invalid', packetSize: 0 };

  // GB: packetSize = 8 + payloadLength (298-301)
  const payloadLen = rxBuf[4] | (rxBuf[5] << 8);
  const packetSize = 8 + payloadLen;
  if (rxBuf.length < packetSize) return { status: 'incomplete', packetSize: 0 };

  // GB: XiaomiSppPacketV2.decode(rxBuf) (311)
  const decoded = SppPacketV2.decode(rxBuf.slice(0, packetSize));
  if (!decoded) return { status: 'invalid', packetSize };

  // GB switch(decodedPacket.getPacketType()) (313-335)
  switch (decoded.packetType) {
    case SppPacketType.SESSION_CONFIG: {
      // GB: log opcode, startEncryptedHandshake() (314-318)
      log('info', `[GB] SessionConfig received, opcode=${decoded.configOpcode}`);
      startEncryptedHandshake(handle);
      break;
    }
    case SppPacketType.DATA: {
      // GB: DataPacket -> onPacketReceived(channel, payload(authService)) (319-327)
      const ch = decoded.channel ?? SppChannel.UNKNOWN;
      let plainPayload = decoded.payload;
      // GB: getPayloadBytes -> decrypt if SEND_ENCRYPTED
      if (decoded.opcode === SppDataOpcode.SEND_ENCRYPTED && handle.encryptionInitialized && handle.authProtocol) {
        try { plainPayload = handle.authProtocol.decryptV2(decoded.payload.slice(2)); }
        catch {} // decrypt fail -> raw kullan
      }
      onPacketReceived(handle, ch, plainPayload);

      // GB: sendAck(sequenceNumber) (261-268)
      const ackPacket = SppPacketV2.buildAck(decoded.sequenceNumber);
      writeRaw(handle, ackPacket);
      break;
    }
    case SppPacketType.ACK:
      log('info', `[GB] ACK seq=${decoded.sequenceNumber}`);
      break;
  }

  return { status: 'complete', packetSize };
}

// ═══════════════════════════════════════════════════════════════════
// GB: onPacketReceived (BleProtocolV2.java:177-184)
//   mChannelHandlers.get(channel).handle(payload)
//   ProtobufCommand -> handleCommandBytes -> auth service dispatch
// ═══════════════════════════════════════════════════════════════════
function onPacketReceived(handle: GBDeviceHandle, channel: SppChannel, payload: Uint8Array) {
  if (channel === SppChannel.PROTOBUF_COMMAND || channel === SppChannel.AUTHENTICATION) {
    // Protobuf payload geldi -> authResolve'a ilet
    if (handle.authResolve) {
      handle.authResolve(payload);
      handle.authResolve = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// GB: XiaomiBleProtocolV2.encodePacket (BleProtocolV2.java:341-349)
//   getAndIncrement + getOpCodeForChannel + encode(authService)
// ═══════════════════════════════════════════════════════════════════
function encodePacket(handle: GBDeviceHandle, channel: SppChannel, payload: Uint8Array): Uint8Array {
  // GB: packetSequenceCounter.getAndIncrement() -> sequence, sonra artir
  const seq = handle.packetSequenceCounter;
  handle.packetSequenceCounter = (handle.packetSequenceCounter + 1) & 0xff;
  // GB: getOpCodeForChannel
  const opcode = (channel === SppChannel.PROTOBUF_COMMAND || channel === SppChannel.ACTIVITY)
    ? SppDataOpcode.SEND_ENCRYPTED : SppDataOpcode.SEND_PLAINTEXT;
  return SppPacketV2.buildDataPacket(channel, opcode, payload);
}

// ═══════════════════════════════════════════════════════════════════
// GB: writeChunks -> WriteAction -> gatt.writeCharacteristic (WriteAction.java)
//   characteristic.getWriteType() -> WRITE_TYPE_NO_RESPONSE (005F WW=true)
// ═══════════════════════════════════════════════════════════════════
async function writeRaw(handle: GBDeviceHandle, data: Uint8Array): Promise<void> {
  if (!handle.btCharacteristicWrite) throw new Error('[GB] no btCharacteristicWrite');
  for (let offset = 0; offset < data.length; offset += handle.maxWriteSize) {
    const chunk = data.slice(offset, offset + handle.maxWriteSize);
    const ab = chunk.slice().buffer as ArrayBuffer;
    // GB: characteristic.getWriteType() -> WRITE_TYPE_NO_RESPONSE
    // Android: writeCharacteristic(char, value, char.getWriteType())
    // Web Bluetooth: writeValueWithoutResponse (005F'de WW=true, W=false)
    await handle.btCharacteristicWrite.writeValueWithoutResponse(ab);
  }
}

// ═══════════════════════════════════════════════════════════════════
// GB: XiaomiBleProtocolV2.sendCommand (BleProtocolV2.java:200-231)
//   type==1 -> Authentication (plaintext)
//   type!=1 -> ProtobufCommand (encrypted via authService)
//   XiaomiSupport.sendCommand(taskName, type, subtype) (Support.java:423-431)
// ═══════════════════════════════════════════════════════════════════
async function sendCommand(handle: GBDeviceHandle, type: number, subtype: number, desc: string): Promise<void> {
  // GB: protobuf Command{type, subtype} (XiaomiSupport.java:424-429)
  const cmdBytes = buildProtobufCommand(type, subtype);

  if (type === 1) {
    // GB: encodePacket(Authentication, payload) -> SEND_PLAINTEXT
    const spp = encodePacket(handle, SppChannel.AUTHENTICATION, cmdBytes);
    log('send', `[GB] ${desc} auth seq=${spp[3]}`);
    await writeRaw(handle, spp);
  } else {
    // GB: encodePacket(ProtobufCommand, payload) -> SEND_ENCRYPTED
    //   DataPacket.getPacketPayloadBytes -> encryptV2(payload) (SppPacketV2.java:375)
    const encrypted = handle.authProtocol!.encryptV2(cmdBytes);
    const spp = encodePacket(handle, SppChannel.PROTOBUF_COMMAND, encrypted);
    log('send', `[GB] ${desc} seq=${spp[3]}`);
    await writeRaw(handle, spp);
  }
}

// ── GB protobuf Command field encoder: {type=1, subtype=N} ──
function buildProtobufCommand(type: number, subtype: number): Uint8Array {
  // field 1 (varint): type
  const t = new Uint8Array([0x08, ...encodeVarint(type)]);
  // field 2 (varint): subtype
  const s = new Uint8Array([0x10, ...encodeVarint(subtype)]);
  const out = new Uint8Array(t.length + s.length);
  out.set(t, 0); out.set(s, t.length);
  return out;
}
function encodeVarint(val: number): Uint8Array {
  if (val < 0x80) return new Uint8Array([val]);
  const b: number[] = [];
  while (val >= 0x80) { b.push((val & 0x7f) | 0x80); val >>>= 7; }
  b.push(val & 0x7f);
  return new Uint8Array(b);
}

// ═══════════════════════════════════════════════════════════════════
// GB: wait for notification (async notification bekleyenler icin)
// ═══════════════════════════════════════════════════════════════════
async function waitForNotification(handle: GBDeviceHandle, timeoutMs: number, label: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (handle.notifyQueue.length > 0) { resolve(handle.notifyQueue.shift()!); return; }
    const t = setTimeout(() => {
      if (handle.notifyResolve === resolve) handle.notifyResolve = null;
      log('warn', `⏱ [GB] ${label} timeout ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    handle.notifyResolve = (v) => { clearTimeout(t); resolve(v); };
  });
}

// ── send + wait for auth response (sendAndWaitAuth pattern) ──
async function sendAndWaitAuth(handle: GBDeviceHandle, data: Uint8Array, timeoutMs: number, label: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (handle.authResolve) handle.authResolve(null);
    const t = setTimeout(() => {
      if (handle.authResolve === resolve) handle.authResolve = null;
      log('warn', `⏱ [GB] ${label} timeout ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    handle.authResolve = (p) => { clearTimeout(t); handle.authResolve = null; resolve(p); };
    writeRaw(handle, data).catch((e) => { clearTimeout(t); handle.authResolve = null; log('error', `${label} write: ${e.message}`); resolve(null); });
  });
}

// ═══════════════════════════════════════════════════════════════════
// GB: XiaomiAuthService.startEncryptedHandshake (AuthService.java:88-95)
//   + handleCommand -> CMD_NONCE -> handleWatchNonce -> CMD_AUTH
// ═══════════════════════════════════════════════════════════════════
function startEncryptedHandshake(handle: GBDeviceHandle) {
  log('info', '[GB] startEncryptedHandshake');

  // GB: encryptionInitialized = false (AuthService.java:89)
  handle.encryptionInitialized = false;

  // GB: secretKey = getSecretKey(device) (AuthService.java:91)
  const ltkStr = localStorage.getItem('be_ltk')!;
  for (let i = 0; i < 16; i++) handle.secretKey[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);

  // GB: nonce = new SecureRandom().nextBytes(16) (AuthService.java:92)
  const randomNonce = crypto.getRandomValues(new Uint8Array(16));
  handle.nonce = randomNonce;

  // GB: getSupport().sendCommand("auth step 1", buildNonceCommand(nonce)) (AuthService.java:94)
  //   buildNonceCommand (AuthService.java:244-256)
  //   -> Command{type=1, subtype=26, auth.phone_nonce{nonce}}
  handle.authProtocol = new SppAuthProtocol(handle.secretKey);
  const { nonce: pn, packet: pnPacket } = handle.authProtocol.buildPhoneNonce();

  // GB: XiaomiBleProtocolV2.sendCommand -> type==1 -> encodePacket(Authentication, ...)
  //   sequence: 0 (getAndIncrement -> 0, counter 1)
  const sppPn = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, pnPacket);
  log('info', `[GB] Auth step 1: PhoneNonce seq=${handle.packetSequenceCounter}`);
  handle.packetSequenceCounter = (handle.packetSequenceCounter + 1) & 0xff;

  // GB: builder.queue() async -> callback queue'dan calisir
  // Web Bluetooth: direkt send + wait
  sendAndWaitAuth(handle, sppPn, 10000, 'WatchNonce').then(async (wnPayload) => {
    if (!wnPayload) { log('error', '[GB] WatchNonce timeout'); return; }
    log('recv', `[GB] WatchNonce: ${toHex(wnPayload)}`);

    // GB: handleWatchNonce (AuthService.java:199-242)
    //   computeAuthStep3Hmac + key split + HMAC verify
    const step3 = await handle.authProtocol!.processWatchNonce(wnPayload);
    if (!step3) { log('error', '[GB] WatchNonce decode failed'); return; }

    // GB: key split (AuthService.java:200-206)
    handle.decryptionKey.set(handle.authProtocol!.keys!.decKey);
    handle.encryptionKey.set(handle.authProtocol!.keys!.encKey);
    handle.decryptionNonce.set(handle.authProtocol!.keys!.decNonce);
    handle.encryptionNonce.set(handle.authProtocol!.keys!.encNonce);

    // GB: auth step 2 -> CMD_AUTH (AuthService.java:142)
    const sppA3 = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, step3.authStep3Packet);
    log('info', `[GB] Auth step 2: AuthStep3 seq=${handle.packetSequenceCounter}`);
    handle.packetSequenceCounter = (handle.packetSequenceCounter + 1) & 0xff;

    sendAndWaitAuth(handle, sppA3, 10000, 'AuthResult').then(async (authPayload) => {
      if (!authPayload) { log('error', '[GB] AuthResult timeout'); return; }
      log('recv', `[GB] AuthResult: ${toHex(authPayload)}`);

      // GB: handleCommand -> CMD_AUTH (AuthService.java:146-166)
      const result = handle.authProtocol!.processAuthResponse(authPayload);
      if (result) {
        // GB: encryptionInitialized = true (AuthService.java:149)
        handle.encryptionInitialized = true;
        // GB: INITIALIZED (AuthService.java:153) -> onAuthSuccess (155)
        handle.state = State.INITIALIZED;
        log('info', '🎉 [GB] AUTH SUCCESS!');

        // GB: onAuthSuccess() (Support.java:405-417)
        await onAuthSuccess(handle);
      } else {
        log('error', '✗ [GB] AUTH FAILED');
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// GB: XiaomiSupport.onAuthSuccess (Support.java:405-417)
//   1. connectionSupport.onAuthSuccess() -> no-op V2
//   2. syncTime() -> systemService.setCurrentTime()
//   3. for each service in mServiceMap: service.initialize()
// ═══════════════════════════════════════════════════════════════════
async function onAuthSuccess(handle: GBDeviceHandle) {
  log('info', '[GB] onAuthSuccess');

  // 2. systemService.setCurrentTime() (Support.java:410-412)
  //   XiaomiSystemService.java:316-353 -> Command{type=2, subtype=3, system{clock{...}}}
  const clockBuf = encodeCommandClock();
  const encClock = handle.authProtocol!.encryptV2(clockBuf);
  const sppClock = encodePacket(handle, SppChannel.PROTOBUF_COMMAND, encClock);
  log('send', `[GB] Clock seq=${sppClock[3]}`);
  await writeRaw(handle, sppClock);

  // 3. mServiceMap.values().forEach(service.initialize()) (Support.java:414-416)
  for (const svc of SERVICE_INIT) {
    for (const cmd of svc.commands) {
      await sendCommand(handle, svc.type, cmd.subtype, cmd.desc);
      // GB: aralarda callback bekleme yok, TransactionBuilder queue'ya ekler
      //     WriteAction sirasi latch ile yonetilir
      // Web Bluetooth: writeWithoutResponse -> callback yok, dogrudan sirayla
    }
  }

  log('info', '[GB] INIT COMPLETE — all services initialized');
}

// ═══════════════════════════════════════════════════════════════════
// GB: BtLEQueue.handleDisconnected (BtLEQueue.java:402-486)
//   Status koduna gore karar:
//     0x81/0x85/0x08/0x93 -> forceDisconnect
//     default + autoReconnect -> gatt.connect() ile hemen reconnect
// ═══════════════════════════════════════════════════════════════════
async function handleDisconnected(handle: GBDeviceHandle): Promise<void> {
  log('warn', '[GB] handleDisconnected');

  // GB: mTransactions.clear(), mAbortTransaction=true (BtLEQueue.java:405-407)
  // GB: pending latch'lari countDown (410-417)

  // GB: autoReconnect (447-464, 471-485)
  if (handle.state === State.INITIALIZED && handle.autoReconnect) {
    if (handle.gattServer) {
      // GB: mBluetoothGatt.connect() (456) -> STATE_CONNECTING
      log('info', '[GB] autoReconnect: gatt.connect()');
      try {
        await handle.gattServer.connect();
        // GB: onConnectionStateChange -> STATE_CONNECTED -> reconnect basarili
        log('info', '[GB] autoReconnect OK');
        handle.state = State.INITIALIZED;
        // Notification'lari yeniden enable (Web Bluetooth gereksinimi)
        if (handle.btCharacteristicRead) {
          try { await handle.btCharacteristicRead.startNotifications(); } catch {}
        }
      } catch (e: any) {
        log('error', `[GB] autoReconnect failed: ${e.message}`);
        // GB: forceDisconnect (459)
        try { handle.gattServer?.disconnect(); } catch {}
        handle.state = State.NOT_CONNECTED;
      }
    } else {
      // GB: WAITING_FOR_RECONNECT (479-480)
      log('info', '[GB] autoReconnect: delayed (gatt null)');
      handle.state = State.WAITING_FOR_RECONNECT;
    }
  } else {
    handle.state = State.NOT_CONNECTED;
  }
}

// ═══════════════════════════════════════════════════════════════════
// DISPATCHER: main.ts'den cagrilacak fonksiyon
//   Disconnect oldugunda autoReconnect ile ayakta kalir
// ═══════════════════════════════════════════════════════════════════
export async function gbFullFlow(handle: GBDeviceHandle, device: BluetoothDevice,
                                  onStatus: (s: string, ok?: boolean) => void,
                                  onAuthSuccessCb?: () => void): Promise<void> {
  try {
    handle.device = device;
    handle.state = State.NONE;
    handle.autoReconnect = true;

    // GB: disconnect event -> handleDisconnected
    device.addEventListener('gattserverdisconnected', async () => {
      log('warn', `[GB] DISCONNECT event` + (handle.encryptionInitialized ? ' (auth complete, reconnecting...)' : ''));
      await handleDisconnected(handle);
    });

    // GB: connect() via BtLEQueue
    await gattConnect(handle);
    onStatus('Connected');

    // GB: initializeDevice -> notify(true) + SessionConfig (BleProtocolV2.java:63-96)
    handle.packetSequenceCounter = 0;  // reset()
    await enableNotifications(handle);
    onStatus('Session Config…');

    // GB: SessionConfig seq=0 hardcoded, counter artmaz (BleProtocolV2.java:86-93)
    const scPacket = SppPacketV2.buildSessionConfigRequest();
    log('info', '[GB] SessionConfig seq=0 (hardcoded, counter unchanged)');
    await writeRaw(handle, scPacket);

    // GB: band SessionConfig response'u beklenir
    //   processPacket -> SessionConfig -> startEncryptedHandshake
    //   auth baslayinca PhoneNonce -> WatchNonce -> AuthStep3
    //   Auth suresi: ~2-3 saniye
    await new Promise(r => setTimeout(r, 3000));
    // Notification'lari bosalt
    for (let i = 0; i < 10; i++) {
      try {
        const n = await waitForNotification(handle, 1000, `drain-${i}`);
        if (!n) break;
      } catch { break; }
    }

    if (!handle.encryptionInitialized) {
      // Auth hala baslamadiysa notification bekle
      log('warn', '[GB] Auth not completed yet');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (handle.encryptionInitialized) break;
      }
    }

    if (!handle.encryptionInitialized) {
      log('error', '[GB] Auth failed to complete');
      return;
    }

    log('info', '[GB] Fully initialized. AutoReconnect active.');

    // Monitor
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const connected = handle.gattServer?.connected ?? false;
      log('info', `  [${i + 1}s] connected=${connected} state=${handle.state} enc=${handle.encryptionInitialized}`);
      if (!connected && handle.state === State.NOT_CONNECTED) {
        log('error', `[GB] Connection lost at ${i + 1}s`);
        break;
      }
    }

    log('info', '[GB] FLOW END');
  } catch (e: any) {
    log('error', `[GB] FATAL: ${e?.message ?? e}`);
    onStatus('Error', false);
  }
}
