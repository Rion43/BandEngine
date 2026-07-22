import './style.css';
import { log, hex } from './logger.js';

// ═══════════════════════════════════════════
// SÜRÜM — bu dosyadaki tek kaynak
// package.json, badge, hep buradan okunur
// ═══════════════════════════════════════════
const VERSION = '2.5';

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════
const OPCODES = { AUTH_INIT: 26, AUTH_RESPONSE: 27, AUTH_CONFIRM: 28,
  HEART_RATE_SUBSCRIBE: 69, HEART_RATE_UNSUBSCRIBE: 70,
  BATTERY_INFO: 12,
};
const CATEGORIES = { SYSTEM: 1, HEALTH: 2, ACTIVITY: 3, NOTIFICATION: 4, DEVICE: 5 };

// ═══════════════════════════════════════════
// CRYPTO
// ═══════════════════════════════════════════
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as any));
}

async function hkdfDerive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const prk = await hmacSha256(ikm, salt);
  const result = new Uint8Array(64);
  let prev = new Uint8Array(0);
  for (let i = 1; i <= 2; i++) {
    const d = new Uint8Array(prev.length + info.length + 1);
    d.set(prev); d.set(info, prev.length); d[d.length - 1] = i;
    const r = await hmacSha256(prk, d);
    result.set(new Uint8Array(r), (i - 1) * 32);
    prev = new Uint8Array(r);
  }
  return result;
}

async function aesCtrEncrypt(data: Uint8Array, key: Uint8Array, counter: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as any, { name: 'AES-CTR' }, false, ['encrypt', 'decrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: counter as any, length: 128 }, k, data as any));
}

// ═══════════════════════════════════════════
// PROTOCOL HELPERS
// ═══════════════════════════════════════════
function encodeHandshakeInit(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + nonce.length);
  out[0] = 0x0a; out[1] = nonce.length; out.set(nonce, 2);
  return out;
}

function buildWearPacket(cmd: number, id: number, type: number, whichPayload: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = cmd;
  out[1] = id;
  out[2] = type;
  out[3] = whichPayload;
  out.set(payload, 4);
  return out;
}

// ═══════════════════════════════════════════
// UI REFS
// ═══════════════════════════════════════════
const $ = (id: string) => document.getElementById(id)!;
const btnConnect      = $('btn-connect') as HTMLButtonElement;
const btnHrStart      = $('btn-hr-start') as HTMLButtonElement;
const btnHrStop       = $('btn-hr-stop') as HTMLButtonElement;
const btnDisconnect   = $('btn-disconnect') as HTMLButtonElement;
const statusDot       = $('status-dot');
const statusText      = $('status-text');
const valBattery      = $('val-battery');
const valCharging     = $('val-charging');
const valHr           = $('val-hr');
const hrChart         = $('hr-chart');
const panelBattery    = $('panel-battery');
const panelHr         = $('panel-hr');
const wizard          = $('wizard');
const mainUI          = $('main-ui');
const ltkInput        = $('ltk-input') as HTMLInputElement;
const btnSaveKey      = $('btn-save-key') as HTMLButtonElement;
const wizardStatus    = $('wizard-status');
const ltkChars        = $('ltk-chars');
const versionBadge    = $('version-badge');

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let gattServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
let hrHistory: number[] = [];
let _sessionAesKey: Uint8Array | null = null;
let _sessionCounter: Uint8Array | null = null;

// ═══════════════════════════════════════════
// SÜRÜM GÖSTER
// ═══════════════════════════════════════════
versionBadge.textContent = `v${VERSION}`;

// ═══════════════════════════════════════════
// WIZARD — LTK textbox
// ═══════════════════════════════════════════

function showWizard() { wizard.style.display = ''; mainUI.style.display = 'none'; }
function showMainUI() { wizard.style.display = 'none'; mainUI.style.display = ''; }

ltkInput.addEventListener('input', () => {
  const raw = ltkInput.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  ltkInput.value = raw;
  ltkChars.textContent = `${raw.length}`;
  ltkChars.parentElement!.className = 'wizard-counter' + (raw.length === 32 ? ' full' : '');

  if (raw.length === 32) {
    ltkInput.className = 'wizard-input valid';
    btnSaveKey.disabled = false;
    wizardStatus.className = 'wizard-status';
    wizardStatus.style.display = 'none';
  } else if (raw.length > 0 && !/^[0-9a-f]+$/.test(raw)) {
    ltkInput.className = 'wizard-input error';
    btnSaveKey.disabled = true;
  } else {
    ltkInput.className = 'wizard-input';
    btnSaveKey.disabled = true;
  }
});

btnSaveKey.addEventListener('click', () => {
  const raw = ltkInput.value;
  if (!/^[0-9a-f]{32}$/i.test(raw)) {
    wizardStatus.className = 'wizard-status error';
    wizardStatus.innerHTML = '❌ Geçerli bir anahtar girin (32 karakter hex: 0-9, a-f)';
    wizardStatus.style.display = 'block';
    return;
  }

  localStorage.setItem('be_ltk', raw.toLowerCase());
  wizardStatus.className = 'wizard-status success';
  wizardStatus.innerHTML = '✅ Güvenlik anahtarı kaydedildi.<br><small>Bu cihazda tekrar girmeniz gerekmeyecek.</small>';
  wizardStatus.style.display = 'block';

  setTimeout(() => { showMainUI(); startConnect(); }, 1500);
});

// ═══════════════════════════════════════════
// SETTINGS — anahtar sıfırlama
// ═══════════════════════════════════════════

$('btn-settings').addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>⚙️ Ayarlar</h3>
      <p>Güvenlik anahtarını sıfırlamak, mevcut anahtarı siler ve yeniden girmenizi gerektirir.</p>
      <div class="btn-row">
        <button class="danger" id="btn-reset-key">🔑 Güvenlik Anahtarını Değiştir</button>
        <button id="btn-close-modal">İptal</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#btn-reset-key')!.addEventListener('click', () => {
    localStorage.removeItem('be_ltk');
    modal.remove();
    gattServer?.disconnect();
    gattServer = null; writeChar = null; notifyChar = null;
    ltkInput.value = ''; ltkChars.textContent = '0';
    btnSaveKey.disabled = true;
    wizardStatus.className = 'wizard-status';
    wizardStatus.style.display = 'none';
    showWizard();
  });

  modal.querySelector('#btn-close-modal')!.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
});

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function setStatus(text: string, ok?: boolean) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (ok === true ? ' connected' : ok === false ? ' error' : '');
}
function setButtons(connected: boolean) {
  btnConnect.disabled = connected; btnDisconnect.disabled = !connected;
  btnHrStart.disabled = true; btnHrStop.disabled = true;
}
function renderChart() {
  const mx = Math.max(...hrHistory, 80);
  hrChart.innerHTML = hrHistory.map((v, i) =>
    `<div class="bar${i === hrHistory.length - 1 ? ' latest' : ''}" style="height:${(v / mx) * 100}%"></div>`
  ).join('');
}
function addHrSample(bpm: number) {
  hrHistory.push(bpm); if (hrHistory.length > 80) hrHistory.shift();
  renderChart(); valHr.textContent = `${bpm}`;
}

async function writeBLE(data: Uint8Array) {
  if (!writeChar) throw new Error('writeChar not ready');
  log('sent', `→ ${hex(data)}`);
  if (writeChar.properties.writeWithoutResponse) {
    // @ts-ignore
    await writeChar.writeValueWithoutResponse(data);
  } else {
    await writeChar.writeValue(data as any);
  }
}

function waitOneNotification(timeout = 10000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!notifyChar) return reject(new Error('notifyChar not ready'));
    const t = setTimeout(() => { c(); reject(new Error(`Timeout ${timeout}ms`)); }, timeout);
    const h = (e: Event) => { c(); resolve(new Uint8Array((e.target as BluetoothRemoteGATTCharacteristic).value!.buffer)); };
    const c = () => { clearTimeout(t); notifyChar!.removeEventListener('characteristicvaluechanged', h); };
    notifyChar.addEventListener('characteristicvaluechanged', h);
  });
}

function startHrListener() {
  if (!notifyChar) return;
  const h = (e: Event) => {
    const r = new Uint8Array((e.target as BluetoothRemoteGATTCharacteristic).value!.buffer);
    log('recv', `HR: ${hex(r)}`);
    if (r.length >= 7) addHrSample(r.length > 7 ? r[7] : 0);
  };
  (notifyChar as any)._hr = h;
  notifyChar.addEventListener('characteristicvaluechanged', h);
}
function stopHrListener() {
  if (!notifyChar) return;
  const h = (notifyChar as any)._hr;
  if (h) { notifyChar.removeEventListener('characteristicvaluechanged', h); delete (notifyChar as any)._hr; }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`⏱ ${label} ${ms}ms`)), ms))]);
}

function uuidExpand(s: string): string {
  const h = s.replace(/^0x/i, '').toLowerCase();
  if (h.length === 4) return `0000${h}-0000-1000-8000-00805f9b34fb`;
  if (h.length === 8) return `${h}-0000-1000-8000-00805f9b34fb`;
  return h;
}
function uuidMatch(a: string, b: string): boolean {
  return a.replace(/-/g,'').toLowerCase().includes(b.replace(/-/g,'').toLowerCase())
      || b.replace(/-/g,'').toLowerCase().includes(a.replace(/-/g,'').toLowerCase());
}

// ═══════════════════════════════════════════
// CONNECT FLOW
// ═══════════════════════════════════════════

async function startConnect() {
  let device: BluetoothDevice | null = null;
  try {
    setStatus('Pairing…'); btnConnect.disabled = true;
    log('info', '═══ CONNECT ═══');

    const SVC_UUIDS = [uuidExpand('fe95'), uuidExpand('fee0'), uuidExpand('fee1'),
      uuidExpand('fee7'), uuidExpand('fef5'), uuidExpand('fef6'),
      '0000180a-0000-1000-8000-00805f9b34fb', '0000180f-0000-1000-8000-00805f9b34fb'];

    try {
      device = await withTimeout(navigator.bluetooth.requestDevice({
        acceptAllDevices: true, optionalServices: SVC_UUIDS,
      }), 30000, 'requestDevice');
    } catch (e: any) {
      // Origin permission hatası → yeniden dene
      log('warn', `requestDevice failed: ${e.message}, retrying...`);
      device = await withTimeout(navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Xiaomi Smart Band' }, { namePrefix: 'Mi Smart Band' }, { namePrefix: 'Mi' }, { namePrefix: 'Band' }],
        optionalServices: SVC_UUIDS,
      }), 30000, 'requestDevice2');
    }
    log('info', `Device: ${device.name ?? '?'}  [${device.id}]`);

    if (!device.gatt) throw new Error('gatt null');
    gattServer = await withTimeout(device.gatt.connect(), 15000, 'connect');
    log('info', 'GATT connected');

    let allSvcs: BluetoothRemoteGATTService[] = [];
    try { allSvcs = await withTimeout(gattServer.getPrimaryServices(), 10000, 'services'); }
    catch { for (const u of SVC_UUIDS) try { allSvcs.push(await withTimeout(gattServer.getPrimaryService(u), 3000, u)); } catch {} }
    log('info', `${allSvcs.length} services`);

    const charMap = new Map<string, BluetoothRemoteGATTCharacteristic[]>();
    for (const s of allSvcs) {
      try {
        const cs = await withTimeout(s.getCharacteristics(), 3000, s.uuid);
        charMap.set(s.uuid, cs);
        log('info', `  ${s.uuid}: ${cs.length} chars`);
      } catch { log('warn', `  ${s.uuid}: skip (timeout)`); continue; }
    }

    const findSvc = (u: string) => { for (const [su] of charMap) if (uuidMatch(su, u)) return su; return null; };
    const findChar = (su: string, s: string) => charMap.get(su)?.find(c => uuidMatch(c.uuid, s)) ?? null;
    const firstWW = (su: string) => charMap.get(su)?.find(c => c.properties.writeWithoutResponse || c.properties.write) ?? null;
    const firstN = (su: string) => charMap.get(su)?.find(c => c.properties.notify || c.properties.indicate) ?? null;

    let wc: BluetoothRemoteGATTCharacteristic | null = null, nc: BluetoothRemoteGATTCharacteristic | null = null;
    const fe95 = findSvc('fe95');
    if (fe95) {
      log('info', `FE95 found`);

      const char50 = findChar(fe95, '0050');
      const char5e = findChar(fe95, '005e');
      const char5f = findChar(fe95, '005f');

      // 0050'den auth state oku
      if (char50?.properties.read) {
        try { log('info', `0050: ${hex(new Uint8Array((await withTimeout(char50.readValue(), 2000, 'r50')).buffer))}`); }
        catch { log('info', `0050: unavailable`); }
      }

      // Mi Band 9 FE95: write 005F → notify 005E (ters kanal)
      if (char5e && char5f) {
        wc = char5f; nc = char5e;
        log('info', `use: W=005F N=005E`);
      } else if (char5e) {
        wc = char5e; nc = char5e;
        log('info', `use: W=005E N=005E (fallback)`);
      } else if (char5f) {
        wc = char5f; nc = char5f;
        log('info', `use: W=005F N=005F (fallback)`);
      }
    }
    if (!wc || !nc) { const f = findSvc('fee0'); if (f) { wc = findChar(f, 'fee1'); nc = findChar(f, 'fee2'); } }
    if (!wc || !nc) { for (const [su] of charMap) { wc = firstWW(su); nc = firstN(su); if (wc && nc) break; } }
    if (!wc || !nc) throw new Error('Chars not found');
    writeChar = wc; notifyChar = nc;
    log('info', `W:${wc.uuid}  N:${nc.uuid}`);

    try {
      await withTimeout(notifyChar.startNotifications(), 5000, 'notif');
      log('info', `Notifications started on ${notifyChar.uuid}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log('error', `startNotifications fail: ${msg}`);
      throw new Error(`notifications: ${msg}`);
    }

    // Ayrıca writeChar da farklıysa onu da dinle
    if (writeChar !== notifyChar && writeChar.properties.notify) {
      try {
        await withTimeout(writeChar.startNotifications(), 3000, 'notif2');
        log('info', `Also listening on ${writeChar.uuid}`);
      } catch {}
    }

    // ═══ AUTH ═══
    log('info', '═══ AUTH ═══');
    const ltkStr = localStorage.getItem('be_ltk')!;
    const ltk = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ltk[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);
    log('info', `LTK loaded`);

    const pNonce = new Uint8Array(16);
    crypto.getRandomValues(pNonce);
    log('info', `PNonce: ${hex(pNonce)}`);

    // RE: WearPacket cmd id type which_payload protobuf
    // cmd=1 (protobuf msg), id=0 (ilk istek), type=0x1a (AUTH_INIT=26)
    const authPayload = encodeHandshakeInit(pNonce);
    const initPkt = buildWearPacket(1, 0, OPCODES.AUTH_INIT, 0, authPayload);
    await writeBLE(initPkt);
    log('info', `AUTH_INIT sent (${initPkt.length}B)`);

    const raw = await withTimeout(waitOneNotification(15000), 15000, 'auth resp');
    log('recv', `AUTH_RESP: ${hex(raw)} (${raw.length}B)`);
    if (raw.length < 19) throw new Error(`Too short: ${raw.length}B`);
    // WearPacket response: type(1) id(1) which_payload(1) protobuf(.)
    // protobuf: HandshakeResponse { bandNonce(bytes=1) signature(bytes=2) }
    const bNonce = raw.subarray(3, 19);
    const sig = raw.subarray(19);

    const derived = await hkdfDerive(ltk, (() => { const s = new Uint8Array(32); s.set(pNonce); s.set(bNonce,16); return s; })(), new TextEncoder().encode('miwear-auth'));
    const aKey = derived.subarray(16, 32); const ctr = derived.subarray(32, 48);
    _sessionAesKey = aKey; _sessionCounter = ctr;

    const vd = new Uint8Array(32); vd.set(pNonce); vd.set(bNonce, 16);
    const esig = (await hmacSha256(derived.subarray(0, 16), vd)).subarray(0, 16);
    log('info', `Sig match: ${hex(esig)} vs ${hex(sig)}`);

    const confPkt = buildWearPacket(1, 1, OPCODES.AUTH_CONFIRM, 0, esig);
    await writeBLE(confPkt);
    log('info', 'AUTH_CONFIRM sent');

    setStatus('Authenticated ✓', true);
    log('info', '═══ AUTH OK ═══');

    // Battery
    try {
      const e = await aesCtrEncrypt(new Uint8Array(), aKey, ctr);
      await writeBLE(buildWearPacket(1, 2, OPCODES.BATTERY_INFO, 0, e));
      const br = await withTimeout(waitOneNotification(5000), 5000, 'bat');
      if (br.length >= 4) {
        valBattery.textContent = `${br[3]}`;
        valCharging.textContent = br.length > 4 && br[4] === 1 ? 'Charging' : 'Not charging';
        panelBattery.style.display = 'block';
      }
    } catch {}

    btnHrStart.disabled = false;
    setStatus('Ready ✓', true);
    log('info', '═══ READY ═══');
  } catch (e: any) {
    const msg = e?.message ?? e?.name ?? (typeof e === 'string' ? e : JSON.stringify(e));
    log('error', `HATA: ${msg}`);
    setStatus(`Error: ${(e as DOMException)?.code || msg}`, false);
    btnConnect.disabled = false;
  }
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

if (localStorage.getItem('be_ltk')) {
  showMainUI();
} else {
  showWizard();
  ltkInput.focus();
}

btnConnect.onclick = startConnect;

btnHrStart.onclick = async () => {
  try {
    if (!writeChar || !_sessionAesKey || !_sessionCounter) throw new Error('Not authed');
    btnHrStart.disabled = true; btnHrStop.disabled = false;
    panelHr.style.display = 'block'; hrHistory = []; renderChart();
    const e = await aesCtrEncrypt(new Uint8Array(), _sessionAesKey, _sessionCounter!);
    await writeBLE(buildWearPacket(1, 3, OPCODES.HEART_RATE_SUBSCRIBE, 0, e));
    startHrListener();
  } catch (e: any) { log('error', `HR: ${e.message}`); }
};

btnHrStop.onclick = async () => {
  try {
    if (!writeChar || !_sessionAesKey || !_sessionCounter) throw new Error('Not authed');
    btnHrStart.disabled = false; btnHrStop.disabled = true;
    stopHrListener();
    const e = await aesCtrEncrypt(new Uint8Array(), _sessionAesKey, _sessionCounter!);
    await writeBLE(buildWearPacket(1, 4, OPCODES.HEART_RATE_UNSUBSCRIBE, 0, e));
  } catch (e: any) { log('error', `HR: ${e.message}`); }
};

btnDisconnect.onclick = () => {
  stopHrListener(); gattServer?.disconnect();
  gattServer = null; writeChar = null; notifyChar = null;
  _sessionAesKey = null; _sessionCounter = null;
  setButtons(false); setStatus('Disconnected');
  panelBattery.style.display = 'none'; panelHr.style.display = 'none';
  btnConnect.disabled = false;
};
