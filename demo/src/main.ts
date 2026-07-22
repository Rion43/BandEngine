import './style.css';
import { log, hex } from './logger.js';

const VERSION = '2.7';

const OPCODES = { AUTH_INIT: 26, AUTH_RESPONSE: 27, AUTH_CONFIRM: 28,
  HEART_RATE_SUBSCRIBE: 69, HEART_RATE_UNSUBSCRIBE: 70, BATTERY_INFO: 12,
};

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

function encodeHandshakeInit(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + nonce.length);
  out[0] = 0x0a; out[1] = nonce.length; out.set(nonce, 2);
  return out;
}

function buildWearPacket(cmd: number, id: number, type: number, whichPayload: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = cmd; out[1] = id; out[2] = type; out[3] = whichPayload;
  out.set(payload, 4);
  return out;
}

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

let gattServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
let hrHistory: number[] = [];
let _sessionAesKey: Uint8Array | null = null;
let _sessionCounter: Uint8Array | null = null;

versionBadge.textContent = `v${VERSION}`;

function showWizard() { wizard.style.display = ''; mainUI.style.display = 'none'; }
function showMainUI() { wizard.style.display = 'none'; mainUI.style.display = ''; }

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
    wizardStatus.innerHTML = '❌ Geçerli bir anahtar girin (32 karakter hex: 0-9, a-f)';
    wizardStatus.style.display = 'block'; return;
  }
  localStorage.setItem('be_ltk', ltkInput.value.toLowerCase());
  wizardStatus.className = 'wizard-status success';
  wizardStatus.innerHTML = '✅ Güvenlik anahtarı kaydedildi.<br><small>Bu cihazda tekrar girmeniz gerekmeyecek.</small>';
  wizardStatus.style.display = 'block';
  setTimeout(() => { showMainUI(); startConnect(); }, 1500);
});

$('btn-settings').addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-box"><h3>⚙️ Ayarlar</h3><p>Güvenlik anahtarını sıfırlamak, mevcut anahtarı siler ve yeniden girmenizi gerektirir.</p><div class="btn-row"><button class="danger" id="btn-reset-key">🔑 Güvenlik Anahtarını Değiştir</button><button id="btn-close-modal">İptal</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#btn-reset-key')!.addEventListener('click', () => {
    localStorage.removeItem('be_ltk'); modal.remove();
    gattServer?.disconnect(); gattServer = null; writeChar = null; notifyChar = null;
    ltkInput.value = ''; ltkChars.textContent = '0'; btnSaveKey.disabled = true; wizardStatus.style.display = 'none'; showWizard();
  });
  modal.querySelector('#btn-close-modal')!.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
});

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
  hrChart.innerHTML = hrHistory.map((v, i) => `<div class="bar${i === hrHistory.length - 1 ? ' latest' : ''}" style="height:${(v / mx) * 100}%"></div>`).join('');
}
function addHrSample(bpm: number) { hrHistory.push(bpm); if (hrHistory.length > 80) hrHistory.shift(); renderChart(); valHr.textContent = `${bpm}`; }

async function writeBLE(data: Uint8Array) {
  if (!writeChar) throw new Error('writeChar not ready');
  if (writeChar.properties.writeWithoutResponse) { // @ts-ignore
    await writeChar.writeValueWithoutResponse(data);
  } else { await writeChar.writeValue(data as any); }
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
  (notifyChar as any)._hr = h; notifyChar.addEventListener('characteristicvaluechanged', h);
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

async function startConnect() {
  let device: BluetoothDevice | null = null;
  try {
    setStatus('Pairing…'); btnConnect.disabled = true;
    log('info', '═══ CONNECT ═══');
    const SVC_UUIDS = [uuidExpand('fe95'), uuidExpand('fee0'), uuidExpand('fee1'),
      uuidExpand('fee7'), uuidExpand('fef5'), uuidExpand('fef6'),
      '0000180a-0000-1000-8000-00805f9b34fb', '0000180f-0000-1000-8000-00805f9b34fb'];
    try {
      device = await withTimeout(navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SVC_UUIDS }), 30000, 'requestDevice');
    } catch (e: any) {
      log('warn', `requestDevice failed: ${e.message}, retrying...`);
      device = await withTimeout(navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'Xiaomi Smart Band' }, { namePrefix: 'Mi Smart Band' }, { namePrefix: 'Mi' }, { namePrefix: 'Band' }], optionalServices: SVC_UUIDS }), 30000, 'requestDevice2');
    }
    log('info', `Device: ${device.name ?? '?'}  [${device.id}]`);
    if (!device.gatt) throw new Error('gatt null');
    gattServer = await withTimeout(device.gatt.connect(), 15000, 'connect');
    log('info', 'GATT connected');

    let allSvcs: BluetoothRemoteGATTService[] = [];
    try { allSvcs = await withTimeout(gattServer.getPrimaryServices(), 10000, 'services'); }
    catch { for (const u of SVC_UUIDS) try { allSvcs.push(await withTimeout(gattServer.getPrimaryService(u), 3000, u)); } catch {} }

    // ADIM 1: FE95 characteristic detayli log
    log('info', `${allSvcs.length} services`);
    const charMap = new Map<string, BluetoothRemoteGATTCharacteristic[]>();
    for (const s of allSvcs) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try { chars = await withTimeout(s.getCharacteristics(), 3000, s.uuid); }
      catch { log('warn', `  ${s.uuid}: skip`); continue; }
      charMap.set(s.uuid, chars);
      for (const c of chars) {
        log('info', `  ${c.uuid}`);
        log('info', `    read=${!!c.properties.read} write=${!!c.properties.write} writeWithoutResponse=${!!c.properties.writeWithoutResponse} notify=${!!c.properties.notify} indicate=${!!c.properties.indicate}`);
      }
    }

    const findSvc = (u: string) => { for (const [su] of charMap) if (uuidMatch(su, u)) return su; return null; };
    const findChar = (su: string, s: string) => charMap.get(su)?.find(c => uuidMatch(c.uuid, s)) ?? null;
    const firstWW = (su: string) => charMap.get(su)?.find(c => c.properties.writeWithoutResponse || c.properties.write) ?? null;
    const firstN = (su: string) => charMap.get(su)?.find(c => c.properties.notify || c.properties.indicate) ?? null;

    let wc: BluetoothRemoteGATTCharacteristic | null = null, nc: BluetoothRemoteGATTCharacteristic | null = null;
    const fe95 = findSvc('fe95');
    if (fe95) {
      const char5e = findChar(fe95, '005e'); const char5f = findChar(fe95, '005f');
      if (char5e && char5f) { wc = char5e; nc = char5f; }
      else if (char5e) { wc = char5e; nc = char5e; }
      else if (char5f) { wc = char5f; nc = char5f; }
    }
    if (!wc || !nc) { const f = findSvc('fee0'); if (f) { wc = findChar(f, 'fee1'); nc = findChar(f, 'fee2'); } }
    if (!wc || !nc) { for (const [su] of charMap) { wc = firstWW(su); nc = firstN(su); if (wc && nc) break; } }
    if (!wc || !nc) throw new Error('Chars not found');
    writeChar = wc; notifyChar = nc;
    const wprops = writeChar.properties;
    log('info', `W:${wc.uuid}  N:${nc.uuid}`);
    log('info', `W-props: R=${!!wprops.read} W=${!!wprops.write} WW=${!!wprops.writeWithoutResponse} N=${!!wprops.notify}`);

    try { await withTimeout(notifyChar.startNotifications(), 5000, 'notif'); }
    catch (e: any) { throw new Error(`notifications: ${e?.message ?? e}`); }
    if (writeChar !== notifyChar && writeChar.properties.notify) { try { await withTimeout(writeChar.startNotifications(), 3000, 'notif2'); } catch {} }

    // ═══ AUTH (PAKET DEGISMIYOR) ══
    log('info', '═══ AUTH ═══');
    const ltkStr = localStorage.getItem('be_ltk')!;
    const ltk = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ltk[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);
    const pNonce = new Uint8Array(16);
    crypto.getRandomValues(pNonce);
    const authPayload = encodeHandshakeInit(pNonce);
    const initPkt = buildWearPacket(1, 0, OPCODES.AUTH_INIT, 0, authPayload);
    const pktHex = hex(initPkt);
    log('info', `PNonce: ${hex(pNonce)}`);
    log('info', `AUTH_INIT: ${pktHex} (${initPkt.length}B)`);

    // ADIM 2+3: write API + basari
    let writeMethodUsed = 'none';
    let writeOk = false;
    try {
      if (wprops.writeWithoutResponse) {
        writeMethodUsed = 'writeValueWithoutResponse';
        log('info', `write API: ${writeMethodUsed}`);
        // @ts-ignore
        await writeChar.writeValueWithoutResponse(initPkt);
      } else {
        writeMethodUsed = 'writeValue';
        log('info', `write API: ${writeMethodUsed}`);
        await writeChar.writeValue(initPkt as any);
      }
      writeOk = true;
      log('info', `Write completed`);
    } catch (e: any) {
      log('error', `write FAILED: ${e?.message ?? e}`);
    }

    // ADIM 4+5: notification counter + hex
    let notifCount = 0;
    let notification: Uint8Array | null = null;
    let notifError: string | null = null;
    try {
      const n = await withTimeout(waitOneNotification(15000), 15000, 'auth resp');
      notifCount++; log('recv', `NOTIFICATION #${notifCount}: ${hex(n)}`); notification = n;
    } catch (e: any) { notifError = e?.message ?? String(e); }

    // ADIM 6: alternatif write dene
    let altResult = 'N/A';
    if (wprops.write && wprops.writeWithoutResponse && !notification) {
      log('info', `DEBUG: char supports write+WW, trying alternate...`);
      const alt = writeMethodUsed === 'writeValueWithoutResponse' ? 'writeValue' : 'writeValueWithoutResponse';
      log('info', `DEBUG: retrying with ${alt}...`);
      try {
        if (alt === 'writeValueWithoutResponse') { // @ts-ignore
          await writeChar.writeValueWithoutResponse(initPkt);
        } else { await writeChar.writeValue(initPkt as any); }
        log('info', `DEBUG: alt write completed`);
        try {
          const n2 = await withTimeout(waitOneNotification(10000), 10000, 'auth retry');
          notifCount++; log('recv', `NOTIFICATION #${notifCount}: ${hex(n2)}`); notification = n2;
          altResult = `yes via ${alt}`;
        } catch (e2: any) { altResult = `no (${e2?.message ?? e2})`; }
      } catch (e2: any) { altResult = `write fail: ${e2?.message ?? e2}`; }
    }

    // ADIM 7: DEBUG REPORT
    const L = (s: string) => log('info', s);
    L(`═══ DEBUG REPORT ═══`);
    L(`Characteristic UUID : ${writeChar?.uuid ?? '?'}`);
    L(`Properties          : R=${!!wprops.read} W=${!!wprops.write} WW=${!!wprops.writeWithoutResponse} N=${!!wprops.notify} I=${!!wprops.indicate}`);
    L(`Write method        : ${writeMethodUsed}`);
    L(`AUTH_INIT hex       : ${pktHex}`);
    L(`Bytes written       : ${initPkt.length}B`);
    L(`Notifications       : ${notifCount > 0 ? `${notifCount} notification(s)` : notifError ? `error: ${notifError}` : '0 in 15s'}`);
    L(`Disconnect reason   : ${!notification ? (notifError || `timeout (${notifCount} notifications)`) : 'N/A (response received)'}`);
    L(`═══════════════════════`);

    if (notifError && !notification) { throw new Error(notifError); }
    if (!notification) { setStatus('Auth timeout - see log', false); btnConnect.disabled = false; return; }

    const raw = notification;
    if (raw.length < 19) throw new Error(`Response too short: ${raw.length}B`);
    const bNonce = raw.subarray(3, 19);
    const sig = raw.subarray(19);
    const derived = await hkdfDerive(ltk, (() => { const s = new Uint8Array(32); s.set(pNonce); s.set(bNonce,16); return s; })(), new TextEncoder().encode('miwear-auth'));
    const aKey = derived.subarray(16, 32); const ctr = derived.subarray(32, 48);
    _sessionAesKey = aKey; _sessionCounter = ctr;
    const vd = new Uint8Array(32); vd.set(pNonce); vd.set(bNonce, 16);
    const esig = (await hmacSha256(derived.subarray(0, 16), vd)).subarray(0, 16);
    log('info', `Sig match: ${hex(esig)} vs ${hex(sig)}`);
    await writeBLE(buildWearPacket(1, 1, OPCODES.AUTH_CONFIRM, 0, esig));
    log('info', 'AUTH_CONFIRM sent');
    setStatus('Authenticated ✓', true);
    log('info', '═══ AUTH OK ═══');

    try {
      const e = await aesCtrEncrypt(new Uint8Array(), aKey, ctr);
      await writeBLE(buildWearPacket(1, 2, OPCODES.BATTERY_INFO, 0, e));
      const br = await withTimeout(waitOneNotification(5000), 5000, 'bat');
      if (br.length >= 4) { valBattery.textContent = `${br[3]}`; valCharging.textContent = br.length > 4 && br[4] === 1 ? 'Charging' : 'Not charging'; panelBattery.style.display = 'block'; }
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

if (localStorage.getItem('be_ltk')) { showMainUI(); } else { showWizard(); ltkInput.focus(); }

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
    btnHrStart.disabled = false; btnHrStop.disabled = true; stopHrListener();
    const e = await aesCtrEncrypt(new Uint8Array(), _sessionAesKey, _sessionCounter!);
    await writeBLE(buildWearPacket(1, 4, OPCODES.HEART_RATE_UNSUBSCRIBE, 0, e));
  } catch (e: any) { log('error', `HR: ${e.message}`); }
};

btnDisconnect.onclick = () => {
  stopHrListener(); gattServer?.disconnect();
  gattServer = null; writeChar = null; notifyChar = null;
  _sessionAesKey = null; _sessionCounter = null;
  setButtons(false); setStatus('Disconnected');
  panelBattery.style.display = 'none'; panelHr.style.display = 'none'; btnConnect.disabled = false;
};
