import './style.css';
import { log, hex as hexLog } from './logger.js';
import { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode } from '../../src/SppPacketV2.js';
import { SppAuthProtocol } from '../../src/SppAuthProtocol.js';
import { SppAckTracker } from '../../src/SppAckTracker.js';
import { toHex } from '../../src/SppAuthMessages.js';

const VERSION = '4.0-auth-final';

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
      // ACK immediately
      writeBLE(SppPacketV2.buildAck(pkt.sequenceNumber)).catch(() => {});
      const ch = SppChannel[pkt.channel ?? -1] ?? '?';
      log('recv', `DATA ch=${ch} op=${SppDataOpcode[pkt.opcode ?? 0]} payload(${pkt.payload.length}B)`);

      // Route to auth handler
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

/** Register authResolve BEFORE write, then wait for response — race condition fix. */
async function sendAndWaitAuth(data: Uint8Array, timeoutMs: number, label: string): Promise<Uint8Array | null> {
  // Register handler first, then send
  return new Promise((resolve) => {
    if (authResolve) authResolve(null);
    const t = setTimeout(() => { authResolve = null; log('warn', `⏱ ${label} timeout ${timeoutMs}ms`); resolve(null); }, timeoutMs);
    authResolve = (p) => { clearTimeout(t); authResolve = null; resolve(p); };
    // Send AFTER handler registered
    writeBLE(data).catch((e) => { clearTimeout(t); authResolve = null; log('error', `${label} write failed: ${e.message}`); resolve(null); });
  });
}

async function writeBLE(data: Uint8Array) {
  if (!writeChar) throw new Error('no writeChar');
  const ab = data.slice().buffer as ArrayBuffer;
  if (writeChar.properties.writeWithoutResponse) {
    await writeChar.writeValueWithoutResponse(ab);
  } else {
    await writeChar.writeValue(ab);
  }
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

// ── MAIN CONNECT: Full auth flow (AŞAMA 3-7) ──

async function startConnect() {
  try {
    setStatus('Pairing…'); btnConnect.disabled = true;
    log('info', '═══ FULL AUTH FLOW ═══');
    sppBuffer = new Uint8Array(); notifyQueue = [];

    const device = await withTimeout(
      navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000fe95-0000-1000-8000-00805f9b34fb'] }, { namePrefix: 'Xiaomi Smart Band' }],
        optionalServices: [],
      }), 30000, 'requestDevice');
    log('info', `Device: ${device.name ?? '?'}`);
    if (!device.gatt) throw new Error('gatt null');
    gattServer = await withTimeout(device.gatt.connect(), 15000, 'connect');
    log('info', 'GATT connected');

    // Try FE95 service first, fallback to all services
    let foundW: BluetoothRemoteGATTCharacteristic | null = null;
    let foundN: BluetoothRemoteGATTCharacteristic | null = null;

    try {
      const service = await withTimeout(gattServer.getPrimaryService('0000fe95-0000-1000-8000-00805f9b34fb'), 10000, 'fe95');
      const chars = await withTimeout(service.getCharacteristics(), 5000, 'fe95-chars');
      log('info', `FE95 chars (${chars.length}):`);
      for (const c of chars) log('info', `  ${c.uuid} (R=${!!c.properties.read} W=${!!c.properties.write} WW=${!!c.properties.writeWithoutResponse} N=${!!c.properties.notify})`);

      const matchUuid = (c: BluetoothRemoteGATTCharacteristic, short: string) =>
        c.uuid.replace(/-/g, '').toLowerCase().includes(short.toLowerCase());

      foundN = chars.find(c => c.properties.notify && matchUuid(c, '005e')) ?? null;
      foundW = chars.find(c => (c.properties.write || c.properties.writeWithoutResponse) && matchUuid(c, '005f')) ?? null;

      if (!foundN || !foundW) {
        const ww = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
        const nf = chars.find(c => c.properties.notify);
        log('warn', `005E/005F not found — fallback W=${ww?.uuid ?? '?'} N=${nf?.uuid ?? '?'}`);
        foundW = foundW ?? ww ?? null;
        foundN = foundN ?? nf ?? null;
      }
    } catch (e: any) {
      log('warn', `FE95 failed: ${e.message}, scanning all services...`);
    }

    // Fallback: scan ALL services
    if (!foundW || !foundN) {
      const allSvcs = await withTimeout(gattServer.getPrimaryServices(), 10000, 'all-svcs');
      log('info', `Scanning ${allSvcs.length} services...`);
      for (const svc of allSvcs) {
        try {
          const sc = await withTimeout(svc.getCharacteristics(), 3000, svc.uuid);
          const ww = sc.find(c => c.properties.writeWithoutResponse || c.properties.write);
          const nf = sc.find(c => c.properties.notify);
          log('info', `  ${svc.uuid}: ${sc.length} chars${ww ? ' W' : ''}${nf ? ' N' : ''}`);
          if (ww && nf && !foundW && !foundN) { foundW = ww; foundN = nf; }
        } catch { }
      }
    }

    if (!foundW || !foundN) throw new Error('No writable/notifiable char pair found');
    writeChar = foundW; notifyChar = foundN;

    notifyChar.removeEventListener('characteristicvaluechanged', onBleNotify);
    notifyChar.addEventListener('characteristicvaluechanged', onBleNotify);
    await withTimeout(notifyChar.startNotifications(), 5000, 'notif');

    // ═══ 1. SESSION CONFIG ═══
    log('info', '═══ 1. SESSION CONFIG ═══');
    SppPacketV2.resetSequence();
    await writeBLE(SppPacketV2.buildSessionConfigRequest());
    setStatus('Session Config sent…');
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

    // Wrap in SPPv2 DATA(AUTHENTICATION, PLAINTEXT)
    const sppPn = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, pnPacket);
    log('sent', `PhoneNonce DATA (${sppPn.length}B): ${hexLog(sppPn)}`);
    // Register authResolve BEFORE write — race condition fix!
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

    // ═══ 4. AUTH STEP 3 (CMD_AUTH=27) ═══
    log('info', '═══ 4. AUTH STEP 3 ═══');
    const sppA3 = SppPacketV2.buildDataPacket(SppChannel.AUTHENTICATION, SppDataOpcode.SEND_PLAINTEXT, step3.authStep3Packet);
    log('sent', `AuthStep3 DATA (${sppA3.length}B): ${hexLog(sppA3)}`);
    // Register authResolve BEFORE write
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
