import './style.css';
import { log, hex } from './logger.js';

// ── UI refs ──
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

// ── Internal BLE state ──
let gattServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
let hrHistory: number[] = [];

// ── Timeout wrapper — tüm async GATT çağrılarında takılmayı önle ──
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`⏱ TIMEOUT [${label}] ${ms}ms`)), ms),
    ),
  ]);
}

// ── UUID normalize — her formatı normalize edip karşılaştır ──
function uuidExpand(shortUuid: string): string {
  const h = shortUuid.replace(/^0x/i, '').toLowerCase();
  if (h.length === 4) return `0000${h}-0000-1000-8000-00805f9b34fb`;
  if (h.length === 8) return `${h}-0000-1000-8000-00805f9b34fb`;
  return h; // zaten full UUID
}

/** Iki UUID'i (short/full/kvv) karşılaştır. */
function uuidMatch(a: string, b: string): boolean {
  const an = a.replace(/-/g, '').toLowerCase();
  const bn = b.replace(/-/g, '').toLowerCase();
  return an === bn || an.endsWith(bn) || bn.endsWith(an);
}

// ── Helpers ──
function setStatus(text: string, ok?: boolean) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (ok === true ? ' connected' : ok === false ? ' error' : '');
}

function setButtons(connected: boolean) {
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
  btnHrStart.disabled = true;
  btnHrStop.disabled = true;
}

function renderChart() {
  const max = Math.max(...hrHistory, 80);
  hrChart.innerHTML = hrHistory
    .map((v, i) =>
      `<div class="bar${i === hrHistory.length - 1 ? ' latest' : ''}" style="height:${(v / max) * 100}%"></div>`,
    )
    .join('');
}

function addHrSample(bpm: number) {
  hrHistory.push(bpm);
  if (hrHistory.length > 80) hrHistory.shift();
  renderChart();
  valHr.textContent = `${bpm}`;
}

// ── BLE notification helpers ──

/** Wait for a single BLE notification with timeout. Returns the raw bytes. */
function waitOneNotification(timeout = 10000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!notifyChar) return reject(new Error('notifyChar not ready'));
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Notification timeout (${timeout}ms)`));
    }, timeout);
    const handler = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      cleanup();
      resolve(new Uint8Array(target.value!.buffer));
    };
    const cleanup = () => {
      clearTimeout(timer);
      notifyChar!.removeEventListener('characteristicvaluechanged', handler);
    };
    notifyChar.addEventListener('characteristicvaluechanged', handler);
  });
}

/** Attach a persistent listener that feeds HR samples into the UI. */
function startHrListener() {
  if (!notifyChar) return;
  const handler = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const raw = new Uint8Array(target.value!.buffer);
    log('recv', `HR notify: ${hex(raw)}`);

    if (raw.length >= 7) {
      const ts     = raw[3] | (raw[4] << 8) | (raw[5] << 16) | (raw[6] << 30);
      const bpm    = raw.length > 7 ? raw[7] : 0;
      const conf   = raw.length > 8 ? raw[8] : 0;
      log('info', `❤ ${bpm} bpm  (ts=${ts} conf=${conf})`);
      addHrSample(bpm);
    }
  };
  (notifyChar as any)._hrHandler = handler;
  notifyChar.addEventListener('characteristicvaluechanged', handler);
}

function stopHrListener() {
  if (!notifyChar) return;
  const handler = (notifyChar as any)._hrHandler;
  if (handler) {
    notifyChar.removeEventListener('characteristicvaluechanged', handler);
    delete (notifyChar as any)._hrHandler;
  }
}

// ── Connect & Authenticate ──
btnConnect.addEventListener('click', async () => {
  let device: BluetoothDevice | null = null;

  try {
    setStatus('Pairing…');
    btnConnect.disabled = true;
    log('info', '═════════ [STEP 1] REQUEST DEVICE ═════════');

    // Bilinen Mi Band service UUID'leri (optionalServices'te kayıtlı olmalı)
    const BAND_SERVICE_UUIDS = [
      uuidExpand('fee0'), // Legacy Mi Band service
      uuidExpand('fee1'), // Auth (bazen ayrı service)
      uuidExpand('fe95'), // Mi Band 6+ yeni service
      uuidExpand('fee7'), // Diğer Xiaomi
      uuidExpand('fef5'),
      uuidExpand('fef6'),
      '0000180a-0000-1000-8000-00805f9b34fb', // DIS
      '0000180f-0000-1000-8000-00805f9b34fb', // Battery
      '00001800-0000-1000-8000-00805f9b34fb', // GAP
      '00001801-0000-1000-8000-00805f9b34fb', // GATT
    ];

    log('info', `OptionalServices (${BAND_SERVICE_UUIDS.length} adet):`);
    BAND_SERVICE_UUIDS.forEach(u => log('info', `  ${u}`));

    try {
      device = await withTimeout(
        navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BAND_SERVICE_UUIDS,
        }),
        30000,
        'requestDevice',
      );
      log('info', `[STEP 1] acceptAllDevices OK`);
    } catch (errA: any) {
      log('warn', `[STEP 1] acceptAllDevices HATA: ${errA.message}`);
      log('info', `[STEP 1] namePrefix filter'larına düşülüyor…`);

      interface MyFilter { services?: string[]; namePrefix?: string; }
      const filters: MyFilter[] = [
        { services: [uuidExpand('fee0')] },
        { namePrefix: 'Xiaomi Smart Band' },
        { namePrefix: 'Mi Smart Band' },
        { namePrefix: 'Xiaomi' },
        { namePrefix: 'Mi Band' },
        { namePrefix: 'Smart Band' },
        { namePrefix: 'Band' },
        { namePrefix: 'Mi' },
      ];

      device = await withTimeout(
        navigator.bluetooth.requestDevice({ filters, optionalServices: BAND_SERVICE_UUIDS }),
        30000,
        'requestDevice-filters',
      );
      log('info', `[STEP 1] namePrefix filter OK`);
    }

    log('info', `══════════ [STEP 2] CIHAZ BILGILERI ══════════`);
    log('info', `  İsim     : "${device.name ?? '(isimsiz)'}"`);
    log('info', `  ID       : ${device.id}`);
    log('info', `  GATT     : ${device.gatt?.connected ?? false}`);
    log('info', `  GATT obj : ${device.gatt ? 'mevcut' : 'NULL!'}`);
    // @ts-ignore
    if ((device as any).uuids?.length) {
      log('info', `  Cihaz UUIDs: ${(device as any).uuids.join(', ')}`);
    } else {
      log('info', `  Cihaz UUIDs: yok`);
    }

    // ──────────────────────────────────────────
    // STEP 3 — GATT CONNECT (timeout 15sn)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 3] GATT CONNECT ═════`);
    if (!device.gatt) throw new Error('[STEP 3] device.gatt NULL');

    try {
      gattServer = await withTimeout(device.gatt.connect(), 15000, 'gatt.connect');
      log('info', `[STEP 3] GATT connected=${gattServer.connected}`);
    } catch (errG: any) {
      log('error', `[STEP 3] gatt.connect HATA: ${errG.message}`);
      log('error', `  stack: ${(errG as Error).stack ?? ''}`);
      throw errG;
    }

    // ──────────────────────────────────────────
    // STEP 4 — GET ALL PRIMARY SERVICES (timeout 10sn)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 4] PRIMARY SERVICELER ═════`);
    let allServices: BluetoothRemoteGATTService[] = [];
    try {
      allServices = await withTimeout(gattServer.getPrimaryServices(), 10000, 'getPrimaryServices');
      log('info', `[STEP 4] ${allServices.length} service bulundu`);
    } catch (errS: any) {
      log('error', `[STEP 4] getPrimaryServices HATA: ${errS.message}`);
      log('info', `[STEP 4] Tek tek getPrimaryService deneniyor…`);
      // Bazı ortamlarda getPrimaryServices() desteklenmez — fallback
      for (const uuid of BAND_SERVICE_UUIDS) {
        try {
          const svc = await withTimeout(gattServer.getPrimaryService(uuid), 3000, `getService(${uuid})`);
          allServices.push(svc);
          log('info', `  + ${uuid}`);
        } catch { /* yok */ }
      }
      log('info', `[STEP 4] Fallback ile ${allServices.length} service bulundu`);
    }

    // ──────────────────────────────────────────
    // STEP 4a — CHARACTERISTIC ENUMERATION
    // Önce tüm characteristic'leri al (paralel, hata yut)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 4a] CHARACTERISTIC ENUMERATION ═════`);

    // Service → characteristic[] haritası
    const charMap = new Map<string, { uuid: string; props: string[] }[]>();
    for (const s of allServices) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await withTimeout(s.getCharacteristics(), 5000, `chars(${s.uuid})`);
      } catch (e: any) {
        log('warn', `  ${s.uuid} → getCharacteristics HATA: ${e.message}`);
        continue;
      }
      log('info', `  ${s.uuid} → ${chars.length} char(s):`);
      const list: { uuid: string; props: string[] }[] = [];
      for (const c of chars) {
        const p: string[] = [];
        if (c.properties.read) p.push('R');
        if (c.properties.write) p.push('W');
        if (c.properties.writeWithoutResponse) p.push('WW');
        if (c.properties.notify) p.push('N');
        if (c.properties.indicate) p.push('I');
        list.push({ uuid: c.uuid, props: p });
        log('info', `    ${c.uuid}  [${p.join('+')}]`);
      }
      charMap.set(s.uuid, list);
    }

    // ──────────────────────────────────────────
    // STEP 5 — AUTO-DETECT WRITE/NOTIFY CHARACTERISTICS
    // Öncelik: FE95 → fee0 → ilk uygun
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 5] CHAR DETECT ═════`);

    function findService(uuid: string): string | null {
      for (const [svcUuid] of charMap) {
        if (uuidMatch(svcUuid, uuid)) return svcUuid;
      }
      return null;
    }

    function findChar(serviceUuid: string, shortUuid: string): string | null {
      const chars = charMap.get(serviceUuid);
      if (!chars) return null;
      for (const c of chars) {
        if (uuidMatch(c.uuid, shortUuid)) return c.uuid;
      }
      return null;
    }

    function findFirstChar(serviceUuid: string, propFilter: (p: string[]) => boolean): string | null {
      const chars = charMap.get(serviceUuid);
      if (!chars) return null;
      for (const c of chars) {
        if (propFilter(c.props)) return c.uuid;
      }
      return null;
    }

    let svcForWrite: BluetoothRemoteGATTService | null = null;
    let svcForNotify: BluetoothRemoteGATTService | null = null;
    let writeUuid = '';
    let notifyUuid = '';

    // ADAY 1: FE95 service (Mi Band 6+)
    //   0050 = read-only (band'dan gelen auth challenge)
    //   005E = writeWithoutResponse + notify (ana veri kanalı)
    //   005F = writeWithoutResponse + notify (ikincil)
    const fe95 = findService('fe95');
    if (fe95) {
      log('info', `[STEP 5] FE95 servisi bulundu`);
      // Write: WW tercih edilir (005E veya 005F)
      const w = findFirstChar(fe95, p => p.includes('WW') || p.includes('W'));
      // Notify: aynı char veya ayrı
      const n = findFirstChar(fe95, p => p.includes('N') || p.includes('I'));
      if (w && n) {
        svcForWrite = svcForNotify = allServices.find(s => s.uuid === fe95)!;
        writeUuid = w;
        notifyUuid = n;
        log('info', `[STEP 5] FE95: write=${w} notify=${n}`);
      } else {
        log('warn', `[STEP 5] FE95'te uygun char yok (w=${w} n=${n})`);
        // Fallback: 005E ve 005F zorla dene
        if (findChar(fe95, '005e') && findChar(fe95, '005f')) {
          svcForWrite = svcForNotify = allServices.find(s => s.uuid === fe95)!;
          writeUuid = findChar(fe95, '005e')!;
          notifyUuid = findChar(fe95, '005f')!;
          log('info', `[STEP 5] FE95 fallback: write=${writeUuid} notify=${notifyUuid}`);
        }
      }
    }

    // ADAY 2: fee0 service (legacy) → fee1 write, fee2 notify
    if (!svcForWrite || !svcForNotify) {
      const fee0 = findService('fee0');
      if (fee0) {
        log('info', `[STEP 5] fee0 servisi bulundu`);
        const w = findChar(fee0, 'fee1');
        const n = findChar(fee0, 'fee2');
        if (w && n) {
          svcForWrite = svcForNotify = allServices.find(s => s.uuid === fee0)!;
          writeUuid = w;
          notifyUuid = n;
          log('info', `[STEP 5] fee0 kullanılacak: write=${w} notify=${n}`);
        }
      }
    }

    // ADAY 3: İlk W+WW bulunan service + ilk N+I bulunan service
    if (!svcForWrite || !svcForNotify) {
      log('info', `[STEP 5] Bilinen servisler yok, ilk uygun char pair taranıyor…`);
      for (const [svcUuid, chars] of charMap) {
        const svc = allServices.find(s => s.uuid === svcUuid)!;
        const w = chars.find(c => c.props.includes('W') || c.props.includes('WW'));
        const n = chars.find(c => c.props.includes('N') || c.props.includes('I'));
        if (w && n) {
          svcForWrite = svcForNotify = svc;
          writeUuid = w.uuid;
          notifyUuid = n.uuid;
          log('info', `[STEP 5] İlk uygun: svc=${svcUuid} write=${w.uuid} notify=${n.uuid}`);
          break;
        }
      }
    }

    if (!svcForWrite || !writeUuid || !notifyUuid) {
      throw new Error(`[STEP 5] Hiçbir uygun write/notify characteristic pair bulunamadı!`);
    }

    // ──────────────────────────────────────────
    // STEP 6 — GET CHARACTERISTIC REFERENCES (timeout 5sn)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 6] GET CHAR REFERENCES ═════`);
    log('info', `  Service   : ${svcForWrite.uuid}`);
    log('info', `  Write char: ${writeUuid}`);
    log('info', `  Notify char: ${notifyUuid}`);

    try {
      writeChar = await withTimeout(svcForWrite.getCharacteristic(writeUuid), 5000, 'getChar(write)');
      notifyChar = await withTimeout(svcForNotify!.getCharacteristic(notifyUuid), 5000, 'getChar(notify)');
      log('info', `[STEP 6] writeChar alındı`);
      log('info', `  write: ${writeChar.properties.write}, writeWithoutResp: ${writeChar.properties.writeWithoutResponse}`);
      log('info', `[STEP 6] notifyChar alındı`);
      log('info', `  notify: ${notifyChar.properties.notify}, indicate: ${notifyChar.properties.indicate}`);
    } catch (errC: any) {
      log('error', `[STEP 6] getCharacteristic HATA: ${errC.message}`);
      throw errC;
    }

    // ──────────────────────────────────────────
    // STEP 7 — START NOTIFICATIONS (timeout 5sn)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 7] START NOTIFICATIONS ═════`);
    try {
      await withTimeout(notifyChar.startNotifications(), 5000, 'startNotifications');
      log('info', `[STEP 7] startNotifications() BAŞARILI`);
    } catch (errN: any) {
      log('error', `[STEP 7] startNotifications HATA: ${errN.message}`);
      log('error', `  stack: ${(errN as Error).stack ?? ''}`);
      throw errN;
    }

    // ──────────────────────────────────────────
    // STEP 8 — AUTH HANDSHAKE
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 8] AUTH HANDSHAKE ═════`);

    const longTermKey = new Uint8Array(16);
    crypto.getRandomValues(longTermKey);
    log('info', `LongTermKey (demo, random): ${hex(longTermKey)}`);

    // 8a: AUTH_INIT (opcode 26)
    const phoneNonce = new Uint8Array(16);
    crypto.getRandomValues(phoneNonce);
    log('info', `Phone nonce: ${hex(phoneNonce)}`);

    const initFrame = new Uint8Array(25);
    initFrame[0] = 100;    // type=PLAINTEXT
    initFrame[1] = 1;      // category=SYSTEM
    initFrame[2] = 26;     // opcode=AUTH_INIT
    initFrame[3] = 0x0a;   // tag field 1 bytes
    initFrame[4] = 16;     // length
    initFrame.set(phoneNonce, 5);
    log('sent', `AUTH_INIT → ${hex(initFrame)}`);

    try {
      await withTimeout(writeChar.writeValue(initFrame), 5000, 'write AUTH_INIT');
      log('info', `[STEP 8a] AUTH_INIT gönderildi (${initFrame.length}B)`);
    } catch (errW: any) {
      log('error', `[STEP 8a] writeValue(AUTH_INIT) HATA: ${errW.message}`);
      log('error', `  stack: ${(errW as Error).stack ?? ''}`);
      throw errW;
    }

    // 8b: AUTH_RESPONSE bekle (opcode 27)
    log('info', `[STEP 8b] AUTH_RESPONSE bekleniyor (timeout 10sn)…`);
    let authResp: Uint8Array;
    try {
      authResp = await withTimeout(waitOneNotification(12000), 12000, 'auth notification');
      log('recv', `AUTH_RESPONSE ← ${hex(authResp)}`);
    } catch (errT: any) {
      log('error', `[STEP 8b] AUTH_RESPONSE alınamadı: ${errT.message}`);
      log('warn', `[STEP 8b] Auth atlanıyor, bağlantı hala açık mı kontrol…`);
      throw errT;
    }

    if (authResp.length < 3) {
      throw new Error(`Auth response too short: ${authResp.length}B`);
    }
    const [rType, rCat, rOp] = authResp;
    log('info', `  Response: type=${rType} cat=${rCat} opcode=${rOp} payload=${authResp.length - 3}B`);

    setStatus('Authenticated ✓', true);
    log('info', '══════════ AUTH COMPLETE ══════════');

    // ──────────────────────────────────────────
    // STEP 9 — BATTERY (opcode 12)
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 9] BATTERY ═════`);
    const batReq = new Uint8Array(3);
    batReq[0] = 100; batReq[1] = 5; batReq[2] = 12;
    log('sent', `BATTERY_REQ → ${hex(batReq)}`);

    try {
      await withTimeout(writeChar.writeValue(batReq), 5000, 'battery write');
      const batResp = await withTimeout(waitOneNotification(5000), 5000, 'battery notify');
      log('recv', `BATTERY_RESP ← ${hex(batResp)}`);
      if (batResp.length >= 4) {
        valBattery.textContent = `${batResp[3]}`;
        valCharging.textContent = batResp.length > 4 && batResp[4] === 1 ? 'Charging' : 'Not charging';
        panelBattery.style.display = 'block';
        log('info', `Battery: ${batResp[3]}%`);
      }
    } catch {
      log('warn', 'Battery sorgusu başarısız (pas geçildi)');
    }

    // ── Ready ──
    btnHrStart.disabled = false;
    setStatus('Ready ✓', true);
    log('info', '══════════ DEVICE READY ══════════');

  } catch (err: any) {
    const errCode = (err as DOMException).code;
    const errName = (err as DOMException).name;
    log('error', `══════════ HATA ══════════`);
    log('error', `  message  : ${err.message ?? err}`);
    log('error', `  code     : ${errCode ?? 'N/A'}`);
    log('error', `  name     : ${errName ?? 'N/A'}`);
    log('error', `  stack    :`);
    const stackLines = ((err as Error).stack ?? '(stack yok)').split('\n');
    stackLines.forEach(line => log('error', `    ${line.trim()}`));
    log('error', `══════════════════════════`);

    setStatus(`Error: ${errCode || errName || err.message}`, false);
    btnConnect.disabled = false;
  }
});

// ── Heart Rate Start ──
btnHrStart.addEventListener('click', async () => {
  try {
    if (!writeChar) throw new Error('Not connected');
    btnHrStart.disabled = true;
    btnHrStop.disabled = false;
    panelHr.style.display = 'block';
    hrHistory = [];
    renderChart();

    const pkt = new Uint8Array(3);
    pkt[0] = 101; pkt[1] = 2; pkt[2] = 69;
    log('sent', `HR_SUBSCRIBE → ${hex(pkt)}`);
    await writeChar.writeValue(pkt);
    startHrListener();
    log('info', 'Heart rate listener active');
  } catch (err: any) {
    log('error', `HR start failed: ${err.message}`);
  }
});

// ── Heart Rate Stop ──
btnHrStop.addEventListener('click', async () => {
  try {
    if (!writeChar) throw new Error('Not connected');
    btnHrStart.disabled = false;
    btnHrStop.disabled = true;
    stopHrListener();
    const pkt = new Uint8Array(3);
    pkt[0] = 101; pkt[1] = 2; pkt[2] = 70;
    log('sent', `HR_UNSUBSCRIBE → ${hex(pkt)}`);
    await writeChar.writeValue(pkt);
    log('info', 'Heart rate stopped');
  } catch (err: any) {
    log('error', `HR stop failed: ${err.message}`);
  }
});

// ── Disconnect ──
btnDisconnect.addEventListener('click', () => {
  stopHrListener();
  gattServer?.disconnect();
  gattServer = null;
  writeChar = null;
  notifyChar = null;
  setButtons(false);
  setStatus('Disconnected');
  panelBattery.style.display = 'none';
  panelHr.style.display = 'none';
  btnConnect.disabled = false;
  log('info', 'Disconnected');
});
