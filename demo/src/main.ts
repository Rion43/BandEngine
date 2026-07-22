import './style.css';
import { log, hex } from './logger.js';

// ═══════════════════════════════════════════
// LTK WIZARD — Mi Fitness backup'tan auth_key çıkar
// ═══════════════════════════════════════════

declare const JSZip: any;
declare const initSqlJs: any;

function showWizard() {
  document.getElementById('wizard')!.style.display = '';
  document.getElementById('main-ui')!.style.display = 'none';
}
function showMainUI() {
  document.getElementById('wizard')!.style.display = 'none';
  document.getElementById('main-ui')!.style.display = '';
}

// ── SQLite WASM yükleyici (3 fallback, tüm ortamlar) ──
const SQLITE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0';

let _SQL: any = null;
async function getSQL(): Promise<any> {
  if (_SQL) return _SQL;

  // Fallback 1: locateFile ile CDN
  const errors: string[] = [];
  for (const base of [SQLITE_CDN, 'https://unpkg.com/sql.js@1.11.0/dist', 'https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist']) {
    try {
      _SQL = await initSqlJs({
        locateFile: (f: string) => `${base}/${f}`,
      });
      return _SQL;
    } catch (e: any) {
      errors.push(`${base}: ${e.message}`);
    }
  }

  // Fallback 2: WASM olmadan çalıştır (bazı browser'lar destekler)
  try {
    _SQL = await initSqlJs({ locateFile: () => '' });
    return _SQL;
  } catch {}

  throw new Error(`SQLite yuklenemedi (3 CDN denendi): ${errors.join(' | ')}`);
}

// ── LTK çıkarıcı (tüm DB şemalarını dene) ──
async function extractKeyFromDB(buffer: ArrayBuffer): Promise<string | null> {
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(buffer));

  // Tüm tablo+sütun isimlerini al
  const tables: any[] = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables.flatMap(t => t.values.map((v: any) => v));

  // Önce device_key tablosunu dene
  const target = tableNames.find((n: string) =>
    /device_key|devicekey|keychain|secure_key/i.test(n)
  );
  if (target) {
    const info: any[] = db.exec(`PRAGMA table_info(${target})`);
    const cols = info[0]?.values.map((v: any) => v[1]) ?? [];
    const keyCol = cols.find((c: string) => /auth_key|encrypt_key|key_value|value|ltk/i.test(c));
    if (keyCol) {
      const rows: any[] = db.exec(`SELECT ${keyCol} FROM ${target} LIMIT 10`);
      for (const r of rows) {
        const v = r.values[0]?.[0];
        if (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v)) { db.close(); return v; }
        if (v instanceof Uint8Array) {
          const h = Array.from(v).map((b: number) => b.toString(16).padStart(2, '0')).join('');
          if (h.length === 32) { db.close(); return h; }
        }
      }
    }
  }

  // Fallback: tüm tablolardaki 32 char hex değerleri ara
  for (const t of tableNames) {
    try {
      const info: any[] = db.exec(`PRAGMA table_info(${t})`);
      const cnames = info[0]?.values.map((v: any) => v[1]) ?? [];
      if (!cnames.some((c: string) => /auth|key|encrypt|secure/i.test(c))) continue;
      const rows: any[] = db.exec(`SELECT * FROM ${t} LIMIT 20`);
      for (const row of rows) {
        for (const val of row.values) {
          if (typeof val === 'string' && /^[0-9a-f]{32}$/i.test(val)) { db.close(); return val; }
          if (val instanceof Uint8Array) {
            const h = Array.from(val).map((b: number) => b.toString(16).padStart(2, '0')).join('');
            if (h.length === 32) { db.close(); return h; }
          }
        }
      }
    } catch {}
  }
  db.close();
  return null;
}

async function detectFileType(buffer: ArrayBuffer): Promise<'zip' | 'sqlite' | null> {
  const h = new Uint8Array(buffer.slice(0, 16));
  const hex = Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('504b0304')) return 'zip';
  if (hex.startsWith('53514c697465')) return 'sqlite';
  return null;
}

async function handleFile(file: File) {
  const ws = document.getElementById('wizard-status')!;
  ws.className = 'wizard-status loading';
  ws.innerHTML = '⏳ Dosya işleniyor…';
  ws.style.display = 'block';

  // Butonu gizle (tekrar tıklanırsa yeniden başlasın)
  document.getElementById('btn-connect-wizard')!.style.display = 'none';

  try {
    const buffer = await file.arrayBuffer();
    const fileType = await detectFileType(buffer);
    if (!fileType) throw new Error('Desteklenmeyen dosya. Android .zip veya iPhone .sqlite gönderin.');

    let key: string | null = null;

    if (fileType === 'zip') {
      const zip = await JSZip.loadAsync(buffer);
      const candidates = ['manifest.sqlite', 'manifest.db', 'device_key.db', 'mi_fit.db'];
      let dbFile: any = null;
      for (const name of candidates) {
        dbFile = zip.file(new RegExp(name, 'i'))[0];
        if (dbFile) break;
      }
      if (!dbFile) {
        // Tüm .sqlite/.db dosyalarını tara
        const all = Object.keys(zip.files).filter(f => /\.(sqlite|db)$/i.test(f));
        if (all.length === 0) throw new Error('ZIP içinde SQLite veritabanı bulunamadı.');
        dbFile = zip.file(all[0]);
      }
      key = await extractKeyFromDB(await dbFile.async('arraybuffer'));
    } else {
      key = await extractKeyFromDB(buffer);
    }

    if (!key) {
      ws.className = 'wizard-status error';
      ws.innerHTML = '❌ Güvenlik anahtarı bu dosyada bulunamadı.';
      return;
    }

    // localStorage'a kaydet
    localStorage.setItem('be_ltk', key);
    ws.className = 'wizard-status success';
    ws.innerHTML = '<span class="check">✅</span> Güvenlik Anahtarı Başarıyla Alındı<p style="font-size:12px;margin-top:4px;opacity:.8">Artık bu cihazda tekrar dosya seçmeniz gerekmeyecek.</p>';

    // Bağlan butonunu göster
    const btn = document.getElementById('btn-connect-wizard')!;
    btn.style.display = '';
    btn.onclick = () => { showMainUI(); startConnect(); };

  } catch (e: any) {
    ws.className = 'wizard-status error';
    const msg = e.message.includes('ZIP') ? '❌ Log dosyası açılamadı.' :
                e.message.includes('SQLite') || e.message.includes('sqlite') ? '❌ manifest.sqlite okunamadı.' :
                '❌ ' + e.message;
    ws.innerHTML = msg;
  }
}

// ═══════════════════════════════════════════
// CONSTANTS (RE: Mi Fitness protocol)
// ═══════════════════════════════════════════

const OPCODES = { AUTH_INIT: 26, AUTH_RESPONSE: 27, AUTH_CONFIRM: 28,
  HEART_RATE_SUBSCRIBE: 69, HEART_RATE_UNSUBSCRIBE: 70,
  BATTERY_INFO: 12, NOTIFICATION_PUSH: 41, NOTIFICATION_CLEAR: 42,
};
const CATEGORIES = { SYSTEM: 1, HEALTH: 2, ACTIVITY: 3, NOTIFICATION: 4, DEVICE: 5 };

// ═══════════════════════════════════════════
// CRYPTO (RE: Session.ts, AESCTR.ts, HKDF.ts)
// ═══════════════════════════════════════════

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, data as any);
  return new Uint8Array(sig);
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
// PROTOCOL HELPERS (RE: PacketEncoder.ts)
// ═══════════════════════════════════════════

function encodeHandshakeInit(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + nonce.length);
  out[0] = 0x0a; out[1] = nonce.length; out.set(nonce, 2);
  return out;
}

function buildPkt(cat: number, op: number, payload: Uint8Array): Uint8Array {
  const type = (cat === CATEGORIES.SYSTEM && op >= 17) ? 100 : 101;
  const out = new Uint8Array(3 + payload.length);
  out[0] = type; out[1] = cat; out[2] = op; out.set(payload, 3);
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
    if (r.length >= 7) {
      addHrSample(r.length > 7 ? r[7] : 0);
    }
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

    device = await withTimeout(navigator.bluetooth.requestDevice({
      acceptAllDevices: true, optionalServices: SVC_UUIDS,
    }), 30000, 'requestDevice');
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
        const cs = await withTimeout(s.getCharacteristics(), 5000, s.uuid);
        charMap.set(s.uuid, cs);
      } catch { continue; }
    }

    const findSvc = (u: string) => { for (const [su] of charMap) if (uuidMatch(su, u)) return su; return null; };
    const findChar = (su: string, s: string) => { const cs = charMap.get(su); if (!cs) return null; return cs.find(c => uuidMatch(c.uuid, s)) ?? null; };
    const firstWW = (su: string) => charMap.get(su)?.find(c => c.properties.writeWithoutResponse || c.properties.write) ?? null;
    const firstN = (su: string) => charMap.get(su)?.find(c => c.properties.notify || c.properties.indicate) ?? null;

    let wc: BluetoothRemoteGATTCharacteristic | null = null, nc: BluetoothRemoteGATTCharacteristic | null = null;
    const fe95 = findSvc('fe95');
    if (fe95) { wc = findChar(fe95, '005e') ?? firstWW(fe95); nc = findChar(fe95, '005f') ?? findChar(fe95, '005e') ?? firstN(fe95); }
    if (!wc || !nc) { const f = findSvc('fee0'); if (f) { wc = findChar(f, 'fee1'); nc = findChar(f, 'fee2'); } }
    if (!wc || !nc) { for (const [su] of charMap) { wc = firstWW(su); nc = firstN(su); if (wc && nc) break; } }
    if (!wc || !nc) throw new Error('Chars not found');
    writeChar = wc; notifyChar = nc;
    log('info', `W:${wc.uuid}  N:${nc.uuid}`);

    await withTimeout(notifyChar.startNotifications(), 5000, 'notif');
    log('info', 'Notifications started');

    // ═══ AUTH ═══
    log('info', '═══ AUTH ═══');
    const ltkStr = localStorage.getItem('be_ltk')!;
    const ltk = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ltk[i] = parseInt(ltkStr.substring(i * 2, i * 2 + 2), 16);
    log('info', `LTK loaded`);

    const pNonce = new Uint8Array(16);
    crypto.getRandomValues(pNonce);
    log('info', `PNonce: ${hex(pNonce)}`);

    const initPkt = buildPkt(CATEGORIES.SYSTEM, OPCODES.AUTH_INIT, encodeHandshakeInit(pNonce));
    await writeBLE(initPkt);
    log('info', `AUTH_INIT sent (${initPkt.length}B)`);

    const raw = await withTimeout(waitOneNotification(15000), 15000, 'auth resp');
    log('recv', `AUTH_RESP: ${hex(raw)} (${raw.length}B)`);
    if (raw.length < 19) throw new Error(`Too short: ${raw.length}B`);
    const bNonce = raw.subarray(3, 19);
    const sig = raw.subarray(19);

    const derived = await hkdfDerive(ltk, (() => { const s = new Uint8Array(32); s.set(pNonce); s.set(bNonce,16); return s; })(), new TextEncoder().encode('miwear-auth'));
    const aKey = derived.subarray(16, 32); const ctr = derived.subarray(32, 48);
    _sessionAesKey = aKey; _sessionCounter = ctr;

    // Verify & confirm
    const vd = new Uint8Array(32); vd.set(pNonce); vd.set(bNonce, 16);
    const esig = (await hmacSha256(derived.subarray(0, 16), vd)).subarray(0, 16);
    log('info', `Sig match: ${hex(esig)} vs ${hex(sig)}`);

    const confPkt = buildPkt(CATEGORIES.SYSTEM, OPCODES.AUTH_CONFIRM, esig);
    await writeBLE(confPkt);
    log('info', 'AUTH_CONFIRM sent');

    setStatus('Authenticated ✓', true);
    log('info', '═══ AUTH OK ═══');

    // Battery
    try {
      const e = await aesCtrEncrypt(new Uint8Array(), aKey, ctr);
      await writeBLE(buildPkt(CATEGORIES.DEVICE, OPCODES.BATTERY_INFO, e));
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
    log('error', `HATA: ${e.message}`);
    setStatus(`Error: ${(e as DOMException).code || e.name || e.message}`, false);
    btnConnect.disabled = false;
  }
}

// ═══════════════════════════════════════════
// WIZARD SETUP
// ═══════════════════════════════════════════

function initWizard() {
  const dropzone = document.getElementById('dropzone')!;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;

  dropzone.onclick = () => fileInput.click();

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
  dropzone.ondragleave = () => dropzone.classList.remove('dragover');
  dropzone.ondrop = (e) => { e.preventDefault(); dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files[0]) handleFile(e.dataTransfer.files[0]); };

  fileInput.onchange = () => { if (fileInput.files?.[0]) handleFile(fileInput.files[0]); };
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

if (localStorage.getItem('be_ltk')) {
  showMainUI();
} else {
  showWizard();
  initWizard();
}

// Settings — anahtar sıfırlama
document.getElementById('btn-settings')!.onclick = () => {
  if (confirm('Güvenlik anahtarını sıfırlamak istediğinize emin misiniz?')) {
    localStorage.removeItem('be_ltk');
    location.reload();
  }
};

// ── Button bindings ──
btnConnect.onclick = startConnect;

btnHrStart.onclick = async () => {
  try {
    if (!writeChar || !_sessionAesKey || !_sessionCounter) throw new Error('Not authed');
    btnHrStart.disabled = true; btnHrStop.disabled = false;
    panelHr.style.display = 'block'; hrHistory = []; renderChart();
    const e = await aesCtrEncrypt(new Uint8Array(), _sessionAesKey, _sessionCounter!);
    await writeBLE(buildPkt(CATEGORIES.HEALTH, OPCODES.HEART_RATE_SUBSCRIBE, e));
    startHrListener();
  } catch (e: any) { log('error', `HR: ${e.message}`); }
};

btnHrStop.onclick = async () => {
  try {
    if (!writeChar || !_sessionAesKey || !_sessionCounter) throw new Error('Not authed');
    btnHrStart.disabled = false; btnHrStop.disabled = true;
    stopHrListener();
    const e = await aesCtrEncrypt(new Uint8Array(), _sessionAesKey, _sessionCounter!);
    await writeBLE(buildPkt(CATEGORIES.HEALTH, OPCODES.HEART_RATE_UNSUBSCRIBE, e));
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
