import './style.css';
import { log, hex as hexLog } from './logger.js';
import { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode } from '../../src/SppPacketV2.js';
import { SppAuthProtocol } from '../../src/SppAuthProtocol.js';
import { SppAckTracker } from '../../src/SppAckTracker.js';
import { toHex } from '../../src/SppAuthMessages.js';
import { encodeCommandClock, encodeCommandDeviceInfo } from '../../src/SppSystemMessages.js';
import { diagWriteDebug } from './BluefyDiagnostic.js';
import { GBDeviceHandle, gbFullFlow } from './GadgetbridgeMode.js';

const VERSION = '6.0-gbmod-v2';

const $ = (id: string) => document.getElementById(id)!;

const btnConnect    = $('btn-connect') as HTMLButtonElement;
const btnDisconnect = $('btn-disconnect') as HTMLButtonElement;
const statusDot     = $('status-dot');
const statusText    = $('status-text');
const versionBadge  = $('version-badge');
const wizard        = $('wizard');
const mainUI        = $('main-ui');
const ltkInput      = $('ltk-input') as HTMLInputElement;
const btnSaveKey    = $('btn-save-key') as HTMLButtonElement;
const wizardStatus  = $('wizard-status');
const ltkChars      = $('ltk-chars');

versionBadge.textContent = `v${VERSION}`;

// ── Diagnostic Test Selection ──
let selectedTest = 0; // 0=normal, 1-12 = tests

function initTestSelector() {
  const radios = document.querySelectorAll('.diag-radio');
  radios.forEach((el, i) => {
    el.addEventListener('click', () => {
      radios.forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      const dot = el.querySelector('.diag-dot')!;
      dot.textContent = '●';
      // Reset other dots
      radios.forEach((e) => {
        if (e !== el) e.querySelector('.diag-dot')!.textContent = '○';
      });
      selectedTest = parseInt(el.getAttribute('data-value') ?? '0');
      const names = ['Normal','TEST 1: idle','TEST 2: Clock','TEST 3: Battery',
        'TEST 4: DeviceInfo','TEST 5: DeviceState','TEST 6: slow 500ms',
        'TEST 7: slow 1000ms','TEST 8: Clock+DI','TEST 9: Clock+Bat',
        'TEST 10: Clock+State'];
      log('info', `🧪 Selected: ${names[selectedTest] ?? '?'}`);
    });
  });
  // Default: select Normal
  if (radios.length > 0) (radios[0] as HTMLElement).click();
}

$('diag-toggle').addEventListener('click', () => {
  const body = $('diag-body');
  const toggle = $('diag-toggle');
  if (body.style.display === 'none') {
    body.style.display = 'flex';
    toggle.textContent = '🧪 Diagnostic Test ▾';
  } else {
    body.style.display = 'none';
    toggle.textContent = '🧪 Diagnostic Test ▸';
  }
});

let selectedDevice: BluetoothDevice | null = null;
let gattServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
let authProtocol: SppAuthProtocol | null = null;

let sppBuffer = new Uint8Array();
let notifyQueue: Uint8Array[] = [];
let notifyResolve: ((d: Uint8Array) => void) | null = null;
let authResolve: ((p: Uint8Array | null) => void) | null = null;

const ackTracker = new SppAckTracker();

// ── Persistent BLE handler ──
function onBleNotify(this: BluetoothRemoteGATTCharacteristic, event: Event) {
  const value = new Uint8Array((event.target as unknown as BluetoothRemoteGATTCharacteristic).value!.buffer);
  if (notifyResolve) { notifyResolve(value); notifyResolve = null; }
  else { notifyQueue.push(value); }
  feedSpp(value);
}

// ── SPPv2 reassembly ──
function feedSpp(data: Uint8Array) {
  const merged = new Uint8Array(sppBuffer.length + data.length);
  merged.set(sppBuffer);
  merged.set(data, sppBuffer.length);
  sppBuffer = merged;
  processSpp();
}

function processSpp() {
  while (sppBuffer.length >= 2) {
    if (sppBuffer[0] !== 0xa5 || sppBuffer[1] !== 0xa5) {
      let next = -1;
      for (let i = 1; i < sppBuffer.length - 1; i++) {
        if (sppBuffer[i] === 0xa5 && sppBuffer[i + 1] === 0xa5) { next = i; break; }
      }
      if (next < 0) { sppBuffer = new Uint8Array(); return; }
      log('warn', `skip ${next}B non-SPP`);
      sppBuffer = sppBuffer.slice(next);
    }
    const size = SppPacketV2.getExpectedPacketSize(sppBuffer);
    if (size === null || sppBuffer.length < size) return;

    const bytes = sppBuffer.slice(0, size);
    sppBuffer = sppBuffer.slice(size);
    const pkt = SppPacketV2.decode(bytes);
    if (!pkt) continue;
    handleSpp(pkt);
  }
}

function handleSpp(pkt: import('../../src/SppPacketV2.js').ParsedPacket) {
  const tn = SppPacketType[pkt.packetType] || `?`;
  log('recv', `SPP ${tn} seq=${pkt.sequenceNumber} len=${pkt.payload.length}`);

  switch (pkt.packetType) {
    case SppPacketType.SESSION_CONFIG: {
      log('recv', `SESSION_CONFIG raw: ${hexLog(pkt.configData ?? pkt.payload)}`);
      if (pkt.configOpcode === 2) {
        const r = SppPacketV2.parseSessionConfigResponse(pkt.configData ?? pkt.payload);
        if (r) {
          log('info', `📋 Session Config:`);
          if (r.version) log('info', `  ✅ VERSION: ${r.version.join('.')}`);
          if (r.maxPacketSize) log('info', `  maxPacketSize: ${r.maxPacketSize}`);
          if (r.txWin) log('info', `  txWin: ${r.txWin}`);
          if (r.sendTimeout) log('info', `  sendTimeout: ${r.sendTimeout}ms`);
          setStatus('Session Config + Version ✓', true);
          log('info', `✅ Version OK. Auth ready to start.`);
        }
      }
      break;
    }

    case SppPacketType.DATA: {
      writeBLE(SppPacketV2.buildAck(pkt.sequenceNumber)).catch(() => {});
      const ch = SppChannel[pkt.channel ?? -1] ?? '?';
      log('recv', `DATA ch=${ch} op=${SppDataOpcode[pkt.opcode ?? 0]} payload(${pkt.payload.length}B)`);
      if (pkt.payload.length > 0 && authResolve) {
        authResolve(pkt.payload);
        authResolve = null;
      }
      break;
    }

    case SppPacketType.ACK:
      log('info', `ACK seq=${pkt.sequenceNumber}`);
      ackTracker.resolve(pkt.sequenceNumber);
      break;
  }
}

// ── Wait helpers ──
function waitOneNotification(timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (notifyQueue.length > 0) { resolve(notifyQueue.shift()!); return; }
    const t = setTimeout(() => { if (notifyResolve === resolve) notifyResolve = null; reject(new Error(`Timeout ${timeoutMs}ms`)); }, timeoutMs);
    notifyResolve = (v) => { clearTimeout(t); resolve(v); };
  });
}

async function sendAndWaitAuth(data: Uint8Array, timeoutMs: number, label: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (authResolve) authResolve(null);
    const t = setTimeout(() => { if (authResolve === resolve) authResolve = null; log('warn', `⏱ ${label} timeout ${timeoutMs}ms`); resolve(null); }, timeoutMs);
    authResolve = (p) => { clearTimeout(t); authResolve = null; resolve(p); };
    writeBLE(data).catch((e) => { clearTimeout(t); authResolve = null; log('error', `${label} write failed: ${e.message}`); resolve(null); });
  });
}

async function writeBLE(data: Uint8Array) {
  if (!writeChar) throw new Error('no writeChar');
  const ab = data.slice().buffer as ArrayBuffer;
  const pktType = data[2] & 0x0f;
  let opcodeStr = '';
  if (pktType === 3 && data.length >= 10) {
    const ch = SppChannel[data[8] as any] ?? '?';
    const op = SppDataOpcode[data[9] as any] ?? '?';
    opcodeStr = `DATA:${ch}/${op}`;
  } else if (pktType === 2) opcodeStr = 'SESSION_CONFIG';
  else if (pktType === 1) opcodeStr = 'ACK';
  else opcodeStr = `type=${pktType}`;

  const {ok} = await diagWriteDebug(async () => {
    if (writeChar!.properties.writeWithoutResponse) {
      await writeChar!.writeValueWithoutResponse(ab);
    } else {
      await writeChar!.writeValue(ab);
    }
  }, writeChar.uuid, data.length, opcodeStr);

  if (!ok) throw new Error('write failed');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`⏱ ${label} ${ms}ms`)), ms))]);
}

async function drainNotifications(initialTimeout: number) {
  try {
    const n = await withTimeout(waitOneNotification(initialTimeout), initialTimeout, 'first');
    log('recv', `Notification (${n.length}B) HEX: ${hexLog(n)}`);
    feedSpp(n);
    await new Promise(r => setTimeout(r, 200));
    for (let i = 0; i < 5; i++) {
      try {
        const extra = await withTimeout(waitOneNotification(1500), 1500, `extra-${i}`);
        log('recv', `Extra (${extra.length}B) HEX: ${hexLog(extra)}`);
        feedSpp(extra);
      } catch { break; }
    }
  } catch (e: any) {
    log('warn', `Notification drain: ${e.message}`);
  }
}

// ── Post-auth test helpers ──

async function sendEncrypted(cmd: Uint8Array, label: string): Promise<void> {
  const enc = await authProtocol!.encryptV2(cmd);
  const spp = SppPacketV2.buildDataPacket(SppChannel.PROTOBUF_COMMAND, SppDataOpcode.SEND_ENCRYPTED, enc);
  log('sent', `${label} SPPv2 (${spp.length}B): ${hexLog(spp)}`);
  await writeBLE(spp);
}

function getBatteryCmd(): Uint8Array { return new Uint8Array([0x08, 0x02, 0x10, 0x01]); }
function getDeviceStateCmd(): Uint8Array { return new Uint8Array([0x08, 0x02, 0x10, 0x4e]); }

async function monitorConnection(durationSec: number): Promise<void> {
  const startMs = Date.now();
  for (let i = 0; i < durationSec; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const stillConnected = gattServer?.connected ?? false;
    log('info', `  [${i + 1}s] connected=${stillConnected} queue=${notifyQueue.length} sppBuf=${sppBuffer.length}`);
    if (!stillConnected) {
      log('error', `❌ Connection LOST at ${i + 1}s (${Date.now() - startMs}ms after auth)`);
      return;
    }
  }
  log('info', `✅ Connection stayed alive for ${durationSec}s`);
}

const TEST_NAMES: Record<number, string> = {
  0: 'Normal (4 komut)',
  1: 'TEST 1: 30s idle',
  2: 'TEST 2: Clock only',
  3: 'TEST 3: Battery only',
  4: 'TEST 4: DeviceInfo only',
  5: 'TEST 5: DeviceState only',
  6: 'TEST 6: Clock→500→DI→500→Bat→500→State',
  7: 'TEST 7: Clock→1000→DI→1000→Bat→1000→State',
  8: 'TEST 8: Clock+DeviceInfo',
  9: 'TEST 9: Clock+Battery',
  10: 'TEST 10: Clock+DeviceState',
  11: 'TEST 11: Plaintext Clock (AUTH ch, SEND_PLAINTEXT)',
  12: 'TEST 12: AES-CTR self-test (encryptV2+decryptV2)',
  13: 'TEST 13: Reconnect sonrasi Clock',
  14: 'GB MOD: full GB flow + autoReconnect',
};

async function runPostAuth(): Promise<void> {
  const test = selectedTest;
  const tname = TEST_NAMES[test] ?? `TEST ${test}`;
  log('info', `========== ${tname} START ==========`);

  if (test === 1) {
    // TEST 1: 30s idle
    await monitorConnection(30);
  } else if (test === 2) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await monitorConnection(30);
  } else if (test === 3) {
    await sendEncrypted(getBatteryCmd(), 'Battery');
    await monitorConnection(30);
  } else if (test === 4) {
    await sendEncrypted(encodeCommandDeviceInfo(), 'DeviceInfo');
    await monitorConnection(30);
  } else if (test === 5) {
    await sendEncrypted(getDeviceStateCmd(), 'DeviceState');
    await monitorConnection(30);
  } else if (test === 6) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await new Promise(r => setTimeout(r, 500));
    await sendEncrypted(encodeCommandDeviceInfo(), 'DeviceInfo');
    await new Promise(r => setTimeout(r, 500));
    await sendEncrypted(getBatteryCmd(), 'Battery');
    await new Promise(r => setTimeout(r, 500));
    await sendEncrypted(getDeviceStateCmd(), 'DeviceState');
    await monitorConnection(30);
  } else if (test === 7) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await new Promise(r => setTimeout(r, 1000));
    await sendEncrypted(encodeCommandDeviceInfo(), 'DeviceInfo');
    await new Promise(r => setTimeout(r, 1000));
    await sendEncrypted(getBatteryCmd(), 'Battery');
    await new Promise(r => setTimeout(r, 1000));
    await sendEncrypted(getDeviceStateCmd(), 'DeviceState');
    await monitorConnection(30);
  } else if (test === 8) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await sendEncrypted(encodeCommandDeviceInfo(), 'DeviceInfo');
    await monitorConnection(30);
  } else if (test === 9) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await sendEncrypted(getBatteryCmd(), 'Battery');
    await monitorConnection(30);
  } else if (test === 10) {
    await sendEncrypted(encodeCommandClock(), 'Clock');
    await sendEncrypted(getDeviceStateCmd(), 'DeviceState');
    await monitorConnection(30);
  } else if (test === 11) {
    // TEST 11: Plaintext Clock on Authentication channel
    const clockBuf = encodeCommandClock();
    const spp = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, clockBuf);
    log('sent', `Plaintext Clock AUTH ch (${spp.length}B): ${hexLog(spp)}`);
    await writeBLE(spp);
    await monitorConnection(30);
  } else if (test === 12) {
    // TEST 12: AES-CTR consistency — encrypt with encKey, decrypt with encKey (symmetric)
    log('info', '═══ AES-CTR SELF-TEST ═══');
    const key = authProtocol!.keys!;
    const testData = new Uint8Array([0x08, 0x02, 0x10, 0x02, 0x08, 0x02, 0x10, 0x01, 0x08, 0x02, 0x10, 0x4e]);
    // encrypt with encKey, then decrypt with encKey (CTR is symmetric, same key)
    const { aesCtrEncrypt } = await import('../../src/SppAuthCrypto.js');
    const enc = await aesCtrEncrypt(testData, key.encKey);
    const dec = await aesCtrEncrypt(enc, key.encKey); // CTR: encrypt with same key = decrypt
    const match = dec.length === testData.length && dec.every((b, i) => b === testData[i]);
    log('info', `Plaintext:  ${toHex(testData)}`);
    log('info', `Encrypted:  ${toHex(enc)}`);
    log('info', `Decrypted:  ${toHex(dec)}`);
    log('info', `Match: ${match ? '✅ YES' : '❌ NO'}`);
    if (match) {
      log('info', '✅ AES-CTR self-test PASSED. Web Crypto consistent.');
      // Şimdi band'a boş encrypted DATA gönder (encKey ile şifrele, band decKey ile decrypt eder)
      log('info', 'Sending empty encrypted DATA to band...');
      const emptyEnc = await authProtocol!.encryptV2(new Uint8Array(0));
      const spp = SppPacketV2.buildDataPacket(SppChannel.PROTOBUF_COMMAND, SppDataOpcode.SEND_ENCRYPTED, emptyEnc);
      log('sent', `Empty enc DATA (${spp.length}B): ${hexLog(spp)}`);
      await writeBLE(spp);
    } else {
      log('error', '❌ AES-CTR self-test FAILED! Web Crypto bug!');
    }
    await monitorConnection(30);
  } else if (test === 13) {
    // TEST 13: Disconnect olunca reconnect + Clock
    log('info', '═══ TEST 13: RECONNECT AFTER DISCONNECT ═══');
    await sendEncrypted(encodeCommandClock(), 'Clock');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const stillConnected = gattServer?.connected ?? false;
      log('info', `  [${i + 1}s] connected=${stillConnected} queue=${notifyQueue.length} sppBuf=${sppBuffer.length}`);
      if (!stillConnected && gattServer) {
        log('info', '🔄 Disconnect oldu, yeniden bağlanıyorum...');
        try {
          const dev = (gattServer as any).device;
          if (dev) {
            gattServer = await dev.gatt.connect();
            log('info', 'Reconnect OK');
            if (notifyChar) {
              notifyChar.removeEventListener('characteristicvaluechanged', onBleNotify);
              notifyChar.addEventListener('characteristicvaluechanged', onBleNotify);
              try { await notifyChar.startNotifications(); } catch {}
            }
            await sendEncrypted(encodeCommandClock(), 'Clock(2)');
            log('info', '✅ Reconnect + Clock success');
          }
        } catch (e: any) {
          log('error', `Reconnect failed: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 5000));
        log('info', `After reconnect: connected=${gattServer?.connected ?? false}`);
        break;
      }
    }
  } else if (test === 14) {
    // GB MOD: startConnect'te yakalanir, buraya gelmez
    log('error', 'GB MOD should not reach runPostAuth');
  }

  log('info', `========== ${tname} END ==========`);
}

// ── UI ──
function showWizard() { wizard.style.display = ''; mainUI.style.display = 'none'; }
function showMainUI() { wizard.style.display = 'none'; mainUI.style.display = ''; }
function setStatus(text: string, ok?: boolean) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (ok === true ? ' connected' : ok === false ? ' error' : '');
}
function setButtons(connected: boolean) {
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
}

ltkInput.addEventListener('input', () => {
  const raw = ltkInput.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  ltkInput.value = raw;
  ltkChars.textContent = `${raw.length}`;
  ltkChars.parentElement!.className = 'wizard-counter' + (raw.length === 32 ? ' full' : '');
  if (raw.length === 32) { ltkInput.className = 'wizard-input valid'; btnSaveKey.disabled = false; wizardStatus.style.display = 'none'; }
  else if (raw.length > 0) { ltkInput.className = 'wizard-input error'; btnSaveKey.disabled = true; }
  else { ltkInput.className = 'wizard-input'; btnSaveKey.disabled = true; }
});

btnSaveKey.addEventListener('click', () => {
  if (!/^[0-9a-f]{32}$/i.test(ltkInput.value)) {
    wizardStatus.className = 'wizard-status error';
    wizardStatus.innerHTML = '❌ 32 hex karakter girin'; wizardStatus.style.display = 'block'; return;
  }
  localStorage.setItem('be_ltk', ltkInput.value.toLowerCase());
  wizardStatus.className = 'wizard-status success';
  wizardStatus.innerHTML = '✅ Key saved';
  wizardStatus.style.display = 'block';
  setTimeout(() => { showMainUI(); }, 1500);
});

$('btn-settings').addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-box"><h3>⚙️ Settings</h3><div class="btn-row"><button class="danger" id="btn-reset-key">🔑 Change Key</button><button id="btn-close-modal">Cancel</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#btn-reset-key')!.addEventListener('click', () => {
    localStorage.removeItem('be_ltk'); modal.remove();
    gattServer?.disconnect(); gattServer = null; writeChar = null; notifyChar = null;
    ltkInput.value = ''; ltkChars.textContent = '0'; btnSaveKey.disabled = true; wizardStatus.style.display = 'none'; showWizard();
  });
  modal.querySelector('#btn-close-modal')!.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
});

// ── MAIN CONNECT ──

async function startConnect() {
  try {
    // GB MOD seciliyse direkt GB flow'a git
    if (selectedTest === 14) {
      const gbHandle = new GBDeviceHandle();
      const dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000fe95-0000-1000-8000-00805f9b34fb'] }, { namePrefix: 'Xiaomi Smart Band' }],
        optionalServices: [],
      });
      await gbFullFlow(gbHandle, dev, setStatus);
      btnConnect.disabled = false;
      return;
    }

    setStatus('Pairing…'); btnConnect.disabled = true;
    log('info', '═══ FULL AUTH FLOW ═══');
    sppBuffer = new Uint8Array(); notifyQueue = [];

    const device = await withTimeout(
      navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000fe95-0000-1000-8000-00805f9b34fb'] }, { namePrefix: 'Xiaomi Smart Band' }],
        optionalServices: [],
      }), 30000, 'requestDevice');
    selectedDevice = device;
    log('info', `Device: ${device.name ?? '?'}`);
    if (!device.gatt) throw new Error('gatt null');

    device.addEventListener('gattserverdisconnected', (ev) => {
      log('warn', `❗ DISCONNECT: gattserverdisconnected event`);
      log('warn', `❗ Device: ${device.name}`);
      setStatus('Disconnected!', false);
      setButtons(false);
    });
    log('info', '→ gattserverdisconnected listener registered');

    gattServer = await withTimeout(device.gatt.connect(), 15000, 'connect');
    log('info', 'GATT connected');

    const service = await withTimeout(gattServer.getPrimaryService('0000fe95-0000-1000-8000-00805f9b34fb'), 10000, 'fe95');
    const chars = await withTimeout(service.getCharacteristics(), 5000, 'fe95-chars');
    const charStr = chars.map((c, i) => {
      if (!c || !c.properties) return `[${i}] undefined`;
      return `[${i}] ${c.uuid} R=${!!c.properties.read} W=${!!c.properties.write} WW=${!!c.properties.writeWithoutResponse} N=${!!c.properties.notify}`;
    }).join('\n');
    log('info', `FE95 characteristics (${chars.length}):\n${charStr}`);
    const char5e = chars.find(c => c.uuid.toLowerCase().includes('005e'));
    const char5f = chars.find(c => c.uuid.toLowerCase().includes('005f'));
    if (!char5e || !char5f) throw new Error('005E/005F not found');

    writeChar = char5f;
    notifyChar = char5e;
    log('info', `W=${writeChar.uuid} N=${notifyChar.uuid}`);
    log('info', `W-props: R=${!!writeChar.properties.read} W=${!!writeChar.properties.write} WW=${!!writeChar.properties.writeWithoutResponse} N=${!!writeChar.properties.notify}`);

    notifyChar.removeEventListener('characteristicvaluechanged', onBleNotify);
    notifyChar.addEventListener('characteristicvaluechanged', onBleNotify);
    await withTimeout(notifyChar.startNotifications(), 5000, 'notif');

    // ═══ 1. SESSION CONFIG ═══
    log('info', '═══ 1. SESSION CONFIG ═══');
    SppPacketV2.resetSequence();
    const scPacket = SppPacketV2.buildSessionConfigRequest();
    log('info', `SessionConfig seq: ${scPacket[3]}, Internal counter after: 1`);
    log('sent', `SessionConfig SPPv2 (${scPacket.length}B): ${hexLog(scPacket)}`);
    await writeBLE(scPacket);
    setStatus('Waiting for Session Config…');
    await drainNotifications(15000);
    await new Promise(r => setTimeout(r, 500));

    // ═══ 2. AUTH: PHONE NONCE (CMD_NONCE=26) ═══
    log('info', '═══ 2. AUTH PHONE NONCE ═══');

    const ltkStr = localStorage.getItem('be_ltk')!;
    const ltk = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ltk[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);

    authProtocol = new SppAuthProtocol(ltk);

    const { nonce: pNonce, packet: pnPacket } = authProtocol.buildPhoneNonce();
    log('info', `PhoneNonce: ${toHex(pNonce)}`);

    const sppPn = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, pnPacket);
    log('info', `PhoneNonce seq: ${sppPn[3]}, Internal counter after: 2`);
    log('sent', `PhoneNonce DATA (${sppPn.length}B): ${hexLog(sppPn)}`);
    const wnPayload = await sendAndWaitAuth(sppPn, 10000, 'WatchNonce');
    if (!wnPayload) {
      log('error', '❌ No WatchNonce - timeout');
      setStatus('WatchNonce timeout', false);
      btnConnect.disabled = false; return;
    }
    log('recv', `WatchNonce raw (${wnPayload.length}B): ${toHex(wnPayload)}`);

    const step3 = await authProtocol.processWatchNonce(wnPayload);
    if (!step3) {
      log('error', '❌ WatchNonce decode failed');
      setStatus('WatchNonce decode failed', false);
      btnConnect.disabled = false; return;
    }

    // ═══ 3. AUTH STEP 3 (CMD_AUTH=27) ═══
    log('info', '═══ 3. AUTH STEP 3 ═══');
    const sppA3 = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, step3.authStep3Packet);
    log('sent', `AuthStep3 DATA (${sppA3.length}B): ${hexLog(sppA3)}`);
    const authPayload = await sendAndWaitAuth(sppA3, 10000, 'AuthResult');
    if (!authPayload) {
      log('error', '❌ No auth result - timeout');
      setStatus('Auth result timeout', false);
      btnConnect.disabled = false; return;
    }
    log('recv', `Auth result raw (${authPayload.length}B): ${toHex(authPayload)}`);

    const result = authProtocol.processAuthResponse(authPayload);
    if (result) {
      log('info', '🎉  AUTH SUCCESS!');
      setStatus('✓ Authenticated', true);
      setButtons(true);

      // ═══ RUN SELECTED TEST ═══
      await runPostAuth();

    } else {
      log('error', '✗  AUTH FAILED');
      setStatus('✗ Auth failed', false);
    }

    log('info', '═══ FULL AUTH FLOW DONE ═══');
    btnConnect.disabled = false;

  } catch (e: any) {
    log('error', `❌ HATA: ${e?.message ?? e}`);
    setStatus('Error', false);
    btnConnect.disabled = false;
  }
}

btnDisconnect.onclick = () => {
  gattServer?.disconnect();
  gattServer = null; writeChar = null; notifyChar = null;
  authProtocol = null;
  sppBuffer = new Uint8Array(); ackTracker.reset();
  setButtons(false); setStatus('Disconnected');
};

if (localStorage.getItem('be_ltk')) { showMainUI(); } else { showWizard(); ltkInput.focus(); }
btnConnect.onclick = startConnect;
initTestSelector();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
