// GadgetbridgeMode — Xiaomi Band 9 Gadgetbridge baglanti akisi, birebir
// Kaynak:
//   XiaomiSupport.java (connect, onAuthSuccess, mServiceMap)
//   XiaomiBleProtocolV2.java (initializeDevice, encodePacket, processPacket)
//   XiaomiAuthService.java (startEncryptedHandshake, handleCommand, encryptV2)
//   XiaomiSppPacketV2.java (encode, DataPacket, SessionConfigPacket)
//   BtLEQueue.java (connect, handleDisconnected, write queue)
//   WriteAction.java (writeCharacteristic, expectsResult)
//   AbstractBTLESingleDeviceSupport.java (connect, disconnect, setContext)

import { log, hex as hexLog } from './logger.js';
import { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode } from '../../src/SppPacketV2.js';
import { SppAuthProtocol } from '../../src/SppAuthProtocol.js';
import { toHex } from '../../src/SppAuthMessages.js';
import { encodeCommandClock, encodeCommandDeviceInfo } from '../../src/SppSystemMessages.js';

// ── Enum: GBDevice.State (GB AbstractBTLESingleDeviceSupport) ──
const DEV_STATE = { INITIALIZING: 1, AUTHENTICATING: 2, INITIALIZED: 3, CONNECTED: 4, NOT_CONNECTED: -1 };

// ── GB XiaomiSupport.mServiceMap (XiaomiSupport.java:92-105) ──
// initialize() sirayla: auth(1) -> music(18) -> health(8) -> notif(7) -> schedule(17)
//   -> weather(10) -> system(2) -> calendar(12) -> watchface(4) -> dataUpload(22)
//   -> phonebook(21) -> rpk(20)
// GB: COMMAND_TYPE her service'de:
const SERVICE_INIT_ORDER: { type: number; name: string; commands: { subtype: number; task: string }[] }[] = [
  // XiaomiAuthService (type=1): initialize() bos
  { type: 1, name: 'auth', commands: [] },
  // XiaomiMusicService (type=18): initialize() bos
  { type: 18, name: 'music', commands: [] },
  // XiaomiHealthService (type=8): setUserInfo + 7 config GET (HealthService.java:195-208)
  { type: 8, name: 'health', commands: [
    { subtype: 0, task: 'set user info' },
    { subtype: 8, task: 'get spo2 config' },
    { subtype: 10, task: 'get heart rate config' },
    { subtype: 12, task: 'get standing reminders config' },
    { subtype: 14, task: 'get stress config' },
    { subtype: 21, task: 'get goal notification config' },
    { subtype: 42, task: 'get goals config' },
    { subtype: 35, task: 'get vitality score config' },
  ]},
  // XiaomiNotificationService (type=7): screenOn + cannedMessages (NotificationService.java:94-99)
  { type: 7, name: 'notification', commands: [
    { subtype: 0, task: 'get screen on on notifications' },
  ]},
  // XiaomiScheduleService (type=17): requestAlarms + requestReminders + requestWorldClocks
  { type: 17, name: 'schedule', commands: [
    { subtype: 0, task: 'get alarms' },
    { subtype: 1, task: 'get reminders' },
    { subtype: 3, task: 'get world clocks' },
  ]},
  // XiaomiWeatherService (type=10): setMeasurementSystem + getLocations (WeatherService.java:77-80)
  { type: 10, name: 'weather', commands: [
    { subtype: 0, task: 'get weather locations' },
  ]},
  // XiaomiSystemService (type=2): 9 komut (SystemService.java:123-143)
  { type: 2, name: 'system', commands: [
    { subtype: 2, task: 'get device info' },
    { subtype: 78, task: 'get device status' },
    { subtype: 1, task: 'get battery state' },
    { subtype: 9, task: 'get password' },
    { subtype: 29, task: 'get display items' },
    { subtype: 7, task: 'get camera remote' },
    { subtype: 51, task: 'get widgets' },
    { subtype: 53, task: 'get widget parts' },
    { subtype: 39, task: 'get workout types' },
  ]},
  // XiaomiCalendarService (type=12): syncCalendar (CalendarService.java:59-61)
  { type: 12, name: 'calendar', commands: [
    { subtype: 0, task: 'sync calendar' },
  ]},
  // XiaomiWatchfaceService (type=4): initialize() bos (sadece state reset)
  { type: 4, name: 'watchface', commands: [] },
  // XiaomiDataUploadService (type=22): initialize() bos
  { type: 22, name: 'dataUpload', commands: [] },
  // XiaomiPhonebookService (type=21): initialize() bos
  { type: 21, name: 'phonebook', commands: [] },
  // XiaomiRpkService (type=20): initialize() bos
  { type: 20, name: 'rpk', commands: [] },
];

export class GBDeviceHandle {
  device: BluetoothDevice | null = null;
  gattServer: BluetoothRemoteGATTServer | null = null;
  charRead: BluetoothRemoteGATTCharacteristic | null = null;  // btCharacteristicRead (005E)
  charWrite: BluetoothRemoteGATTCharacteristic | null = null;  // btCharacteristicWrite (005F)

  // GB: BtLEQueue state
  connected = false;
  state = DEV_STATE.NOT_CONNECTED;  // GBDevice.State

  // GB: XiaomiBleProtocolV2.packetSequenceCounter
  sequenceCounter = 0;

  // GB: ByteArrayOutputStream buffer (reassembly)
  buffer = new Uint8Array();

  // GB: XiaomiAuthService state
  authProtocol: SppAuthProtocol | null = null;
  encryptionInitialized = false;
  secretKey: Uint8Array | null = null;
  nonce: Uint8Array | null = null;
  decryptionKey = new Uint8Array(16);
  encryptionKey = new Uint8Array(16);
  decryptionNonce = new Uint8Array(4);
  encryptionNonce = new Uint8Array(4);

  // GB: internal notification queue
  notificationData: Uint8Array[] = [];
  notificationResolve: ((data: Uint8Array) => void) | null = null;

  // GB: sendCommand callback queue
  commandResolve: ((data: Uint8Array | null) => void) | null = null;

  // Max write chunk (GB: maxWriteSize = calcMaxWriteChunk(MTU))
  maxWriteSize = 244;
}

// ── GB BtLEQueue.connect() (BtLEQueue.java:292-322) ──
//   -> connectImp() (324-367) -> gatt.connect()
export async function gbConnect(handle: GBDeviceHandle): Promise<void> {
  log('info', `[GB] connect()`);
  const device = handle.device;
  if (!device || !device.gatt) throw new Error('GB: no device');

  // GB: setDeviceConnectionState(CONNECTING)
  handle.state = DEV_STATE.INITIALIZING;

  // GB: connectImp()
  //   -> BluetoothDevice.connectGatt(context, false, callback)
  handle.gattServer = await device.gatt.connect();
  log('info', `[GB] Connected to ${device.name}`);

  // GB: onConnectionStateChange -> STATE_CONNECTED
  //   -> discoverServices -> onServicesDiscovered
  handle.connected = true;
  handle.state = DEV_STATE.INITIALIZING;

  // GB: discoverServices (automatic in Web Bluetooth via getPrimaryService)
  const service = await handle.gattServer.getPrimaryService('0000fe95-0000-1000-8000-00805f9b34fb');
  const chars = await service.getCharacteristics();
  handle.charRead = chars.find(c => c.uuid.toLowerCase().includes('005e')) ?? null;
  handle.charWrite = chars.find(c => c.uuid.toLowerCase().includes('005f')) ?? null;
  if (!handle.charRead || !handle.charWrite) throw new Error('005E/005F not found');

  log('info', `[GB] W=${handle.charWrite.uuid} N=${handle.charRead.uuid}`);

  // GB: notify(btCharacteristicRead, true) -> startNotifications
  await handle.charRead.startNotifications();
  handle.charRead.addEventListener('characteristicvaluechanged', (ev: Event) => {
    const target = ev.target as unknown as BluetoothRemoteGATTCharacteristic;
    const value = new Uint8Array(target.value!.buffer);
    gbOnCharacteristicChanged(handle, value);
  });

  // GB: onMtuChanged -> calcMaxWriteChunk(mtu) -> 244
  // Web Bluetooth: varsayilan MTU 512+

  log('info', `[GB] Services discovered, notifications enabled`);
}

// ── GB onCharacteristicChanged (BleProtocolV2.java:110-127) ──
function gbOnCharacteristicChanged(handle: GBDeviceHandle, value: Uint8Array) {
  // GB: buffer.write(value)
  const merged = new Uint8Array(handle.buffer.length + value.length);
  merged.set(handle.buffer);
  merged.set(value, handle.buffer.length);
  handle.buffer = merged;

  // GB: processBuffer()
  gbProcessBuffer(handle);

  // Also push to notification queue for command waiters
  if (handle.notificationResolve) {
    handle.notificationResolve(value);
    handle.notificationResolve = null;
  } else {
    handle.notificationData.push(value);
  }
}

// ── GB processBuffer() (BleProtocolV2.java:144-175) ──
function gbProcessBuffer(handle: GBDeviceHandle) {
  let shouldProcess = true;
  while (shouldProcess) {
    const buf = handle.buffer;
    const result = gbProcessPacket(handle, buf);
    let skipBytes = 0;

    switch (result.status) {
      case 'incomplete':
        skipBytes = 0;
        shouldProcess = false;
        break;
      case 'complete':
        skipBytes = result.packetSize;
        break;
      case 'invalid':
        skipBytes = gbFindNextPacketOffset(buf);
        if (skipBytes < 0) skipBytes = buf.length;
        break;
    }

    if (skipBytes > 0) {
      if (skipBytes >= buf.length) {
        handle.buffer = new Uint8Array();
      } else {
        handle.buffer = buf.slice(skipBytes);
      }
    }
  }
}

// ── GB findNextPacketOffset (BleProtocolV2.java:270-277) ──
function gbFindNextPacketOffset(buffer: Uint8Array): number {
  // GB: sadece 0xA5 ara (ilk preamble byte)
  for (let i = 1; i < buffer.length; i++) {
    if (buffer[i] === 0xa5) return i;
  }
  return -1;
}

// ── GB processPacket (BleProtocolV2.java:279-339) ──
function gbProcessPacket(handle: GBDeviceHandle, rxBuf: Uint8Array): { status: string; packetSize: number } {
  if (rxBuf.length < 8) {
    return { status: 'incomplete', packetSize: 0 };
  }

  // Check preamble: 0xA5 0xA5
  if (rxBuf[0] !== 0xa5 || rxBuf[1] !== 0xa5) {
    return { status: 'invalid', packetSize: 0 };
  }

  // Read packetSize from header: 8 + payloadLength
  const payloadLen = (rxBuf[5] << 8) | rxBuf[4]; // LE uint16
  const packetSize = 8 + payloadLen;

  if (rxBuf.length < packetSize) {
    return { status: 'incomplete', packetSize: 0 };
  }

  // GB: XiaomiSppPacketV2.decode(rxBuf)
  const decoded = SppPacketV2.decode(rxBuf.slice(0, packetSize));
  if (!decoded) {
    return { status: 'invalid', packetSize };
  }

  // GB switch(decodedPacket.getPacketType())
  switch (decoded.packetType) {
    case SppPacketType.SESSION_CONFIG: {
      // GB: log opcode, then startEncryptedHandshake() immediately
      //   XiaomiBleProtocolV2.java:314-318
      log('info', `[GB] SessionConfig received, opcode=${decoded.configOpcode}`);
      // GB: response icinde version bilgisi yok sayilir (TODO)
      //   -> authService.startEncryptedHandshake()
      gbStartEncryptedHandshake(handle);
      break;
    }
    case SppPacketType.DATA: {
      // GB: DataPacket.getPayloadBytes(authService) -> decrypt
      //   XiaomiBleProtocolV2.java:319-327
      const dataPacket = decoded;
      const ch = SppChannel[dataPacket.channel ?? -1] ?? '?';
      let payload = dataPacket.payload;
      if (dataPacket.opcode === SppDataOpcode.SEND_ENCRYPTED && handle.encryptionInitialized) {
        try {
          payload = gbDecryptV2(handle, dataPacket.payload.slice(2));
        } catch (e: any) {
          log('warn', `[GB] Decrypt failed: ${e.message}`);
        }
      }
      log('send', `[GB] DATA ch=${ch} len=${payload.length}`);
      // GB: onPacketReceived(channel, payload) -> handler map
      gbOnPacketReceived(handle, dataPacket.channel ?? SppChannel.UNKNOWN, payload);
      // GB: sendAck(decodedPacket.getSequenceNumber())
      //   XiaomiBleProtocolV2.java:261-268
      //   AckPacket.Builder().setSequenceNumber(seq).build().encode(null)
      void gbWriteRaw(handle, SppPacketV2.buildAck(dataPacket.sequenceNumber));
      break;
    }
    case SppPacketType.ACK:
      // GB: sadece debug log (BleProtocolV2.java:329-331)
      log('info', `[GB] ACK seq=${decoded.sequenceNumber}`);
      break;
  }

  // GB ParseResult(Complete, packetSize)
  return { status: 'complete', packetSize };
}

// ── GB onPacketReceived (BleProtocolV2.java:177-184) ──
function gbOnPacketReceived(handle: GBDeviceHandle, channel: SppChannel, payload: Uint8Array) {
  if (channel === SppChannel.PROTOBUF_COMMAND || channel === SppChannel.AUTHENTICATION) {
    // ProtobufCommand -> handleCommandBytes -> XiaomiAuthService.handleCommand
    //   XiaomiSupport.java:197-215
    // Auth bilgisi commandResolve ile demo'ya iletilir
    if (handle.commandResolve) {
      handle.commandResolve(payload);
      handle.commandResolve = null;
    }
  }
  // Diger channel'lar: Version -> handleVersionPacket, Activity -> activityFetcher
  // Simdilik yoksay
}

// ── GB sendAck (BleProtocolV2.java:261-268) ──
//   writeChunks(builder, AckPacket.Builder().setSequenceNumber(seq).build().encode(null))

// ── GB encodePacket (BleProtocolV2.java:341-349) ──
function gbEncodePacket(handle: GBDeviceHandle, channel: SppChannel, payloadBytes: Uint8Array): Uint8Array {
  // GB XiaomiSppPacketV2.newDataPacketBuilder()
  //   .setChannel(channel)
  //   .setSequenceNumber(packetSequenceCounter.getAndIncrement())
  //   .setOpCode(getOpCodeForChannel(channel))
  //   .setPayload(payloadBytes)
  //   .encode(authService)
  const seq = handle.sequenceCounter;
  handle.sequenceCounter = (handle.sequenceCounter + 1) & 0xff;
  const opcode = gbGetOpCodeForChannel(channel);
  return SppPacketV2.buildDataPacket(channel, opcode, payloadBytes);
}

// ── GB getOpCodeForChannel (SppPacketV2.java:336-348) ──
function gbGetOpCodeForChannel(channel: SppChannel): SppDataOpcode {
  switch (channel) {
    case SppChannel.AUTHENTICATION: return SppDataOpcode.SEND_PLAINTEXT;
    case SppChannel.PROTOBUF_COMMAND: return SppDataOpcode.SEND_ENCRYPTED;
    default: return SppDataOpcode.SEND_PLAINTEXT;
  }
}

// ── GB write (WriteAction.java + TransactionBuilder.writeChunkedData) ──
//   GB: writeChunks(builder, value) -> builder.writeChunkedData(writeChar, value, maxWriteSize)
//   -> WriteAction.run() -> writeCharacteristicImp()
//   -> gatt.writeCharacteristic(characteristic, value, characteristic.getWriteType())
//   -> waits for onCharacteristicWrite callback (expectsResult=true)
//   -> latch.await()
export async function gbWriteRaw(handle: GBDeviceHandle, data: Uint8Array): Promise<void> {
  if (!handle.charWrite) throw new Error('GB: no btCharacteristicWrite');
  // GB: chunking for large packets
  for (let offset = 0; offset < data.length; offset += handle.maxWriteSize) {
    const chunk = data.slice(offset, offset + handle.maxWriteSize);
    const ab = chunk.slice().buffer as ArrayBuffer;
    // GB: characteristic.getWriteType() -> property'ye gore otomatik
    if (handle.charWrite.properties.writeWithoutResponse) {
      await handle.charWrite.writeValueWithoutResponse(ab);
    } else {
      await handle.charWrite.writeValue(ab);
    }
  }
}

// ── GB writeChunks (BleProtocolV2.java:351-353) → writeChunkedData → WriteAction ──
async function gbWriteChunks(handle: GBDeviceHandle, data: Uint8Array): Promise<void> {
  // GB: builder.writeChunkedData(btCharacteristicWrite, value, maxWriteSize)
  //   -> her chunk icin ayri WriteAction -> latch.await
  // Web Bluetooth: direkt yaz, chunk gerekirse parcala
  const chunkSize = Math.min(handle.maxWriteSize, 512);
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.slice(offset, offset + chunkSize);
    await gbWriteRaw(handle, chunk);
  }
}

// ── GB XiaomiAuthService.startEncryptedHandshake() ──
//   XiaomiAuthService.java:88-95
function gbStartEncryptedHandshake(handle: GBDeviceHandle) {
  log('info', `[GB] startEncryptedHandshake`);

  // GB: encryptionInitialized = false
  handle.encryptionInitialized = false;

  // GB: secretKey = getSecretKey(device)
  const ltkStr = localStorage.getItem('be_ltk')!;
  handle.secretKey = new Uint8Array(16);
  for (let i = 0; i < 16; i++) handle.secretKey[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);

  // GB: nonce = SecureRandom.nextBytes(16)
  handle.nonce = crypto.getRandomValues(new Uint8Array(16));

  // GB: auth step 1 -> buildNonceCommand(nonce)
  //   XiaomiAuthService.java:244-256
  const authProt = new SppAuthProtocol(handle.secretKey);
  handle.authProtocol = authProt;
  const { nonce: pNonce, packet: pnPacket } = authProt.buildPhoneNonce();
  handle.nonce = pNonce;

  // GB: sendCommand("auth step 1", command)
  //   type=1, subtype=26, auth.phone_nonce
  //   -> encodePacket(Authentication, command.toByteArray())
  const sppPn = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, pnPacket);
  log('info', `[GB] Auth step 1: PhoneNonce seq=${handle.sequenceCounter}`);
  handle.sequenceCounter = (handle.sequenceCounter + 1) & 0xff;
  void gbWriteRaw(handle, sppPn).then(() => {
    // Wait for WatchNonce response
    gbWaitForNotification(handle, 10000, 'WatchNonce').then(async (wnPayload) => {
      if (!wnPayload) { log('error', '[GB] WatchNonce timeout'); return; }
      log('recv', `[GB] WatchNonce: ${toHex(wnPayload)}`);

      // GB: handleWatchNonce (XiaomiAuthService.java:199-242)
      //   computeAuthStep3Hmac + key split + HMAC verify
      const step3 = await authProt.processWatchNonce(wnPayload);
      if (!step3) { log('error', '[GB] WatchNonce decode failed'); return; }

      // GB: auth step 2 -> CMD_AUTH
      const sppA3 = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, step3.authStep3Packet);
      log('info', `[GB] Auth step 2: AuthStep3 seq=${handle.sequenceCounter}`);
      handle.sequenceCounter = (handle.sequenceCounter + 1) & 0xff;
      void gbWriteRaw(handle, sppA3).then(async () => {
        const authPayload = await gbWaitForNotification(handle, 10000, 'AuthResult');
        if (!authPayload) { log('error', '[GB] AuthResult timeout'); return; }

        // GB: handleCommand -> CMD_AUTH -> encryptionInitialized = true
        const result = authProt.processAuthResponse(authPayload);
        if (result) {
          handle.encryptionInitialized = true;
          log('info', '🎉 [GB] AUTH SUCCESS!');

          // GB: key split (XiaomiAuthService.java:200-206)
          handle.decryptionKey.set(authProt.keys!.decKey);
          handle.encryptionKey.set(authProt.keys!.encKey);
          handle.decryptionNonce.set(authProt.keys!.decNonce);
          handle.encryptionNonce.set(authProt.keys!.encNonce);

          // GB: setUpdateState(INITIALIZED) + onAuthSuccess()
          handle.state = DEV_STATE.INITIALIZED;
          await gbOnAuthSuccess(handle);
        } else {
          log('error', '✗ [GB] AUTH FAILED');
        }
      });
    });
  });
}

// ── GB XiaomiAuthService.encryptV2 → ctrCrypt (AES/CTR/NoPadding, key-as-IV) ──
function gbEncryptV2(handle: GBDeviceHandle, message: Uint8Array): Uint8Array {
  // GB: encryptV2 -> ctrCrypt(ENCRYPT_MODE, encryptionKey, encryptionKey, message)
  //   XiaomiAuthService.java:365-391
  if (!handle.authProtocol) return message;
  return handle.authProtocol.encryptV2(message);
}

function gbDecryptV2(handle: GBDeviceHandle, ciphertext: Uint8Array): Uint8Array {
  // GB: decryptV2 -> ctrCrypt(DECRYPT_MODE, decryptionKey, decryptionKey, ciphertext)
  if (!handle.authProtocol) return ciphertext;
  return handle.authProtocol.decryptV2(ciphertext);
}

// ── GB sendCommand (BleProtocolV2.java:200-231) ──
//   type==1 -> Authentication channel, PLAINTEXT
//   type!=1 -> ProtobufCommand channel, ENCRYPTED
async function gbSendCommand(handle: GBDeviceHandle, type: number, subtype: number, task: string): Promise<void> {
  // GB: protobuf Command{type, subtype}
  const cmdBytes = gbBuildCommandBytes(type, subtype);

  if (type === 1) {
    // GB: encodePacket(Authentication, command.toByteArray())
    //   Authentication -> getOpCodeForChannel -> SEND_PLAINTEXT
    const spp = gbEncodePacket(handle, SppChannel.AUTHENTICATION, cmdBytes);
    log('send', `[GB] ${task} (type=${type} sub=${subtype}) seq=${spp[3]}`);
    await gbWriteChunks(handle, spp);
  } else {
    // GB: encodePacket(ProtobufCommand, command.toByteArray())
    //   ProtobufCommand -> getOpCodeForChannel -> SEND_ENCRYPTED
    const encrypted = gbEncryptV2(handle, cmdBytes);
    const spp = gbEncodePacket(handle, SppChannel.PROTOBUF_COMMAND, encrypted);
    log('send', `[GB] ${task} (type=${type} sub=${subtype}) seq=${spp[3]}`);
    await gbWriteChunks(handle, spp);
  }
}

// ── GB sendCommand overload (XiaomiSupport.java:423-431) ──
//   sendCommand(taskName, type, subtype) -> Command{type, subtype}
async function gbSendCommandSimple(handle: GBDeviceHandle, type: number, subtype: number, task: string): Promise<void> {
  await gbSendCommand(handle, type, subtype, task);
}

// ── GB: protobuf Command{type, subtype} encoder ──
function gbBuildCommandBytes(type: number, subtype: number): Uint8Array {
  const typeField = gbVarint((1 << 3) | 0); // field 1, wire type 0 -> 0x08
  const typeVal = gbVarint(type);
  const subField = gbVarint((2 << 3) | 0); // field 2, wire type 0 -> 0x10
  const subVal = gbVarint(subtype);
  return new Uint8Array([...typeField, ...typeVal, ...subField, ...subVal]);
}

function gbVarint(val: number): Uint8Array {
  if (val < 0x80) return new Uint8Array([val]);
  const bytes: number[] = [];
  while (val >= 0x80) { bytes.push((val & 0x7f) | 0x80); val >>>= 7; }
  bytes.push(val & 0x7f);
  return new Uint8Array(bytes);
}

// ── GB XiaomiSupport.onAuthSuccess() (XiaomiSupport.java:405-417) ──
//   1. connectionSupport.onAuthSuccess() (XiaomiBleSupport -> bleProtocol.onAuthSuccess = no-op V2)
//   2. syncTime() -> systemService.setCurrentTime()
//   3. for each service in mServiceMap: service.initialize()
async function gbOnAuthSuccess(handle: GBDeviceHandle) {
  log('info', `[GB] onAuthSuccess -> sync time + service init`);

  // 2. Clock (systemService.setCurrentTime) -> type=2, subtype=3
  //   XiaomiSystemService.java:316-353
  const clockProto = encodeCommandClock();
  const encClock = gbEncryptV2(handle, clockProto);
  const sppClock = gbEncodePacket(handle, SppChannel.PROTOBUF_COMMAND, encClock);
  log('send', `[GB] Clock seq=${sppClock[3]}`);
  await gbWriteChunks(handle, sppClock);

  // 3. Her service.initialize() sirasiyla
  for (const svc of SERVICE_INIT_ORDER) {
    if (svc.name === 'auth' || svc.name === 'music') continue; // bos initialize
    for (const cmd of svc.commands) {
      await gbSendCommandSimple(handle, svc.type, cmd.subtype, cmd.task);
    }
  }

  log('info', `[GB] ALL SERVICES INITIALIZED`);
}

// ── GB wait for notification (notification bekleyenler icin) ──
async function gbWaitForNotification(handle: GBDeviceHandle, timeoutMs: number, label: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (handle.notificationData.length > 0) {
      resolve(handle.notificationData.shift()!);
      return;
    }
    const t = setTimeout(() => {
      if (handle.notificationResolve === resolve) handle.notificationResolve = null;
      log('warn', `⏱ [GB] ${label} timeout ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    handle.notificationResolve = (v) => { clearTimeout(t); resolve(v); };
  });
}

// ── GB handleDisconnected + autoReconnect (BtLEQueue.java:402-486) ──
//   handleDisconnected(status):
//     normal status (!=0x81/0x85/0x08/0x93) && autoReconnect=true && bluetoothGatt != null
//       -> gatt.connect() -> reconnect
//     autoReconnect=false veya hata -> forceDisconnect
async function gbHandleDisconnected(handle: GBDeviceHandle): Promise<boolean> {
  log('warn', `[GB] handleDisconnected - attempting autoReconnect`);
  try {
    if (!handle.device?.gatt) return false;
    // GB: if (btGatt != null && getAutoReconnect()) -> gatt.connect()
    //   mBluetoothGatt.connect() -> onConnectionStateChange
    handle.gattServer = await handle.device.gatt.connect();
    log('info', `[GB] AutoReconnect OK`);

    // GB: reconnect sonrasi service discovery gerekmez (cache)
    //     notification'lar otomatik kalir (Android'de)
    // Web Bluetooth'da yeniden enable gerekebilir
    if (handle.charRead) {
      try { await handle.charRead.startNotifications(); } catch {}
    }
    return true;
  } catch (e: any) {
    log('error', `[GB] AutoReconnect failed: ${e.message}`);
    return false;
  }
}

// ── FULL GB FLOW: dispatcher ──
export async function gbFullFlow(handle: GBDeviceHandle, onStatus: (s: string, ok?: boolean) => void): Promise<void> {
  try {
    onStatus('Pairing…');
    log('info', '═══ GB MOD: FULL FLOW ═══');

    // 1. Request device
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['0000fe95-0000-1000-8000-00805f9b34fb'] }, { namePrefix: 'Xiaomi Smart Band' }],
      optionalServices: [],
    });
    handle.device = device;

    // 2. AutoReconnect: disconnect event listener (GB: handleDisconnected)
    device.addEventListener('gattserverdisconnected', async () => {
      log('warn', `[GB] gattserverdisconnected`);
      if (handle.encryptionInitialized) {
        const ok = await gbHandleDisconnected(handle);
        if (ok) {
          log('info', `[GB] Reconnected, state preserved`);
        } else {
          onStatus('Disconnected!', false);
        }
      }
    });

    // 3. GB: connect() -> connectImp() -> gatt.connect()
    await gbConnect(handle);
    onStatus('Session Config…');

    // GB: initializeDevice() SessionConfig gonderimi:
    //   XiaomiBleProtocolV2.java:86-93
    //   setSequenceNumber(0) -> hardcoded, counter degismez
    const scPacket = SppPacketV2.buildSessionConfigRequest();
    log('info', `[GB] SessionConfig seq=0`);
    await gbWriteRaw(handle, scPacket);

    // GB: band SessionConfig response'u donene kadar bekle
    //   processPacket -> startEncryptedHandshake callback
    //   Bu async olarak devam eder (startEncryptedHandshake -> auth process flow)
    //   Auth suresi boyunca bekle
    await new Promise(r => setTimeout(r, 2000));

    // Auth sonrasi monitor
    log('info', `[GB] Monitoring (autoReconnect active)`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const connected = handle.gattServer?.connected ?? false;
      log('info', `  [${i + 1}s] connected=${connected} state=${handle.state} enc=${handle.encryptionInitialized}`);
      if (!connected && handle.encryptionInitialized) {
        log('warn', `[GB] Disconnect at ${i + 1}s, autoReconnecting...`);
        const reconnected = await gbHandleDisconnected(handle);
        if (reconnected) continue;
        else { log('error', `[GB] Lost connection`); break; }
      }
    }

    log('info', `═══ GB MOD: FLOW END ═══`);
  } catch (e: any) {
    log('error', `[GB] FATAL: ${e?.message ?? e}`);
    onStatus('Error', false);
  }
}
