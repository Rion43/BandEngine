import './style.css';
import { log, hex } from './logger.js';

// ═══════════════════════════════════════════
// LTK WIZARD — Mi Fitness backup'tan encrypt_key çıkar
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

// ── SQLite WASM yükleyici ──
const SQLITE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0';
let _SQL: any = null;
async function getSQL(): Promise<any> {
  if (_SQL) return _SQL;
  const errors: string[] = [];
  for (const base of [SQLITE_CDN, 'https://unpkg.com/sql.js@1.11.0/dist', 'https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist']) {
    try { _SQL = await initSqlJs({ locateFile: (f: string) => `${base}/${f}` }); return _SQL; }
    catch (e: any) { errors.push(`${base}: ${e.message}`); }
  }
  try { _SQL = await initSqlJs({ locateFile: () => '' }); return _SQL; } catch {}
  throw new Error(`SQLite yuklenemedi: ${errors.join(' | ')}`);
}

// ── Binary Plist (bplist00) parser ──
function parseBPList(buf: Uint8Array): any {
  const magic = new TextDecoder().decode(buf.slice(0, 8));
  if (magic !== 'bplist00') throw new Error('Not bplist00');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = buf.length;
  const tr = len - 32;
  const offTableOff = Number(dv.getBigUint64(tr + 8, false));
  const numObj = Number(dv.getBigUint64(tr + 16, false));
  const rootIdx = dv.getUint32(tr + 24, false);
  const offSz = (tr - offTableOff) / numObj;
  const offs: number[] = [];
  for (let i = 0; i < numObj; i++) {
    const p = offTableOff + i * offSz;
    if (offSz === 1) offs.push(buf[p]);
    else if (offSz === 2) offs.push(dv.getUint16(p, false));
    else if (offSz === 4) offs.push(dv.getUint32(p, false));
    else offs.push(Number(dv.getBigUint64(p, false)));
  }

  function refSize() { return numObj <= 256 ? 1 : numObj <= 65536 ? 2 : 4; }

  function readObj(pos: number): any {
    const b = buf[pos];
    const type = (b >> 4) & 0xf;
    const info = b & 0xf;
    let p = pos + 1;

    function readLen(): { length: number, after: number } {
      if (info <= 0x0e) return { length: info, after: p };
      // info == 0x0f: length follows as inline int byte
      const sub = buf[p]; p++;
      const subType = (sub >> 4) & 0xf;
      let subInfo = sub & 0xf;
      // Sometimes it's 0x1_ format = integer with byte count from nibble
      // Actually in bplist, after 0x0f, the next byte indicates int sizing:
      // bits: 0x1k where k=0→1B, 1→2B, 2→4B, 3→8B
      let intBytes: number;
      if (subType === 1) intBytes = 1 << subInfo; // proper integer encoding
      else intBytes = 1 << (sub & 0x03); // fallback
      let length = 0;
      for (let i = 0; i < intBytes; i++) { length = (length << 8) | buf[p]; p++; }
      return { length, after: p };
    }

    switch (type) {
      case 0: return null;
      case 1: return false;
      case 2: return true;
      case 4: { // integer
        const byteLen = 1 << info;
        if (byteLen === 1) return buf[p];
        if (byteLen === 2) return dv.getUint16(p, false);
        if (byteLen === 4) return dv.getUint32(p, false);
        if (byteLen === 8) return Number(dv.getBigUint64(p, false));
        return 0;
      }
      case 5: return info === 2 ? dv.getFloat32(p, false) : dv.getFloat64(p, false);
      case 6: return dv.getFloat64(p, false);
      case 8: { // data
        const { length, after } = readLen();
        return buf.slice(after, after + length);
      }
      case 9: { // ASCII string
        const { length, after } = readLen();
        return new TextDecoder().decode(buf.slice(after, after + length));
      }
      case 0xa: { // Unicode string (UTF-16BE)
        const { length, after } = readLen();
        const chars: string[] = [];
        for (let i = 0; i < length; i++) {
          const cp = (buf[after + i * 2] << 8) | buf[after + i * 2 + 1];
          chars.push(String.fromCharCode(cp));
        }
        return chars.join('');
      }
      case 0xc: { // array
        const { length, after } = readLen();
        const rs = refSize();
        const arr: any[] = [];
        for (let i = 0; i < length; i++) {
          let idx: number;
          if (rs === 1) idx = buf[after + i];
          else if (rs === 2) idx = dv.getUint16(after + i * 2, false);
          else idx = dv.getUint32(after + i * 4, false);
          arr.push(readObj(offs[idx]));
        }
        return arr;
      }
      case 0xd: { // dictionary
        const { length, after } = readLen();
        const rs = refSize();
        const keyRefs: number[] = [];
        const valRefs: number[] = [];
        const keyArea = after;
        const valArea = after + length * rs;
        for (let i = 0; i < length; i++) {
          if (rs === 1) { keyRefs.push(buf[keyArea + i]); valRefs.push(buf[valArea + i]); }
          else if (rs === 2) { keyRefs.push(dv.getUint16(keyArea + i * 2, false)); valRefs.push(dv.getUint16(valArea + i * 2, false)); }
          else { keyRefs.push(dv.getUint32(keyArea + i * 4, false)); valRefs.push(dv.getUint32(valArea + i * 4, false)); }
        }
        const dict: any = {};
        for (let i = 0; i < length; i++) {
          const k = readObj(offs[keyRefs[i]]);
          if (k != null) dict[String(k)] = readObj(offs[valRefs[i]]);
        }
        return dict;
      }
      default: return null;
    }
  }

  return readObj(offs[rootIdx]);
}

// ── NSKeyedArchiver'dan encrypt_key çıkar ──
function extractKeyFromArchiver(root: any): string | null {
  if (!root || typeof root !== 'object') return null;

  // NSKeyedArchiver: root.$objects + root.$top
  if (root.$archiver !== 'NSKeyedArchiver') {
    // Düz dictionary olabilir (iOS 15+)
    return findKeyInDict(root);
  }

  const objects: any[] = root.$objects || [];
  const top = root.$top;
  if (!top || !objects.length) return null;

  // $top'taki ilk değere git
  const topKeys = Object.keys(top);
  if (!topKeys.length) return null;
  const topRef = top[topKeys[0]];
  // NSKeyedArchiver'da $top değeri bir NSObject (dictionary) veya $UID referansı
  let realRoot: any = null;
  if (topRef && typeof topRef === 'object' && topRef.$UID != null) {
    realRoot = objects[topRef.$UID];
  } else if (typeof topRef === 'number') {
    realRoot = objects[topRef];
  } else {
    realRoot = topRef;
  }

  return findKeyInDict(realRoot);
}

function findKeyInDict(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;

  // Doğrudan encrypt_key varsa
  for (const key of ['encrypt_key', 'encryptkey', 'EncryptKey', 'LTK', 'ltk', 'auth_key']) {
    const val = obj[key];
    if (val) {
      const hex = toHex(val);
      if (hex && hex.length === 32) return hex;
    }
  }

  // İç içe dolaş
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const r = findKeyInDict(v);
      if (r) return r;
    }
  }
  return null;
}

function toHex(val: any): string | null {
  if (typeof val === 'string' && /^[0-9a-f]{32}$/i.test(val)) return val.toLowerCase();
  if (val instanceof Uint8Array || val?.buffer instanceof ArrayBuffer) {
    const arr = val instanceof Uint8Array ? val : new Uint8Array(val);
    if (arr.length === 16) {
      return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  }
  // NSData from bplist: berimbil boxed
  if (val?.$UID != null) return null; // skip refs
  return null;
}

// ── manifest.sqlite'den key çıkar ──
async function extractKeyFromDB(buffer: ArrayBuffer): Promise<string | null> {
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(buffer));

  // Tüm tabloları listele
  const tables: any[] = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables.flatMap(t => t.values.map((v: any) => v));

  // manifest tablosu + inline_data sütunu
  for (const t of tableNames) {
    const info: any[] = db.exec(`PRAGMA table_info(${t})`);
    const cols = info[0]?.values.map((v: any) => v[1]) ?? [];
    const dataCol = cols.find((c: string) => /inline_data|data|blob|value/i.test(c));
    if (!dataCol) continue;
    const rows: any[] = db.exec(`SELECT ${dataCol} FROM ${t} LIMIT 20`);
    for (const row of rows) {
      for (const val of row.values) {
        if (!val) continue;
        const bytes: Uint8Array = val instanceof Uint8Array ? val : new Uint8Array(val);
        // bplist00 magic byte check
        if (bytes.length < 12 || bytes[0] !== 0x62 /*b*/) continue;
        try {
          const plist = parseBPList(bytes);
          if (!plist) continue;
          const key = extractKeyFromArchiver(plist);
          if (key) { db.close(); return key; }
        } catch {}
      }
    }
  }

  db.close();
  return null;
}

async function detectFileType(buffer: ArrayBuffer): Promise<'zip' | 'sqlite' | null> {
  const h = new Uint8Array(buffer.slice(0, 16));
  const hexStr = Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hexStr.startsWith('504b0304')) return 'zip';
  if (hexStr.startsWith('53514c697465')) return 'sqlite';
  return null;
}

async function handleFile(file: File) {
  const ws = document.getElementById('wizard-status')!;
  ws.className = 'wizard-status loading';
  ws.innerHTML = '⏳ Dosya işleniyor…';
  ws.style.display = 'block';
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
