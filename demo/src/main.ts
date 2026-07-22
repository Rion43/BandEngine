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

    // Payload starts at byte 3 (after type/cat/op header)
    // Opcode 53 / cat 2 → protobuf { timestamp, heartRate, confidence }
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

    // ── ENUMERATE all known primary services on Xiaomi Band ──
    const BAND_SERVICE_UUIDS = [
      // Mi Band primary service
      '0000fee0-0000-1000-8000-00805f9b34fb',
      // Authentication service
      '0000fee1-0000-1000-8000-00805f9b34fb',
      // Device Information (DIS)
      '0000180a-0000-1000-8000-00805f9b34fb',
      // Battery Service
      '0000180f-0000-1000-8000-00805f9b34fb',
      // Generic Access
      '00001800-0000-1000-8000-00805f9b34fb',
      // Generic Attribute
      '00001801-0000-1000-8000-00805f9b34fb',
      // Device ID
      '0000180a-0000-1000-8000-00805f9b34fb',
      // Human Interface Device
      '00001812-0000-1000-8000-00805f9b34fb',
      // Unknown Xiaomi services
      '0000fee7-0000-1000-8000-00805f9b34fb',
      '0000fef5-0000-1000-8000-00805f9b34fb',
      '0000fef6-0000-1000-8000-00805f9b34fb',
    ];

    log('info', `BLE taraması başlıyor — acceptAllDevices ile tüm cihazlar listelenecek`);
    log('info', `OptionalServices (${BAND_SERVICE_UUIDS.length} adet) kayıtlı:`);
    BAND_SERVICE_UUIDS.forEach(u => log('info', `  ${u}`));

    try {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BAND_SERVICE_UUIDS,
      });
      log('info', `[STEP 1a] acceptAllDevices OK — cihaz seçildi`);
    } catch (errA: any) {
      log('warn', `[STEP 1a] acceptAllDevices HATA: ${errA.message} (code=${(errA as DOMException).code})`);
      log('info', `[STEP 1a] namePrefix filter'larına düşülüyor…`);

      interface MyFilter { services?: string[]; namePrefix?: string; }
      const filters: MyFilter[] = [
        { services: ['0000fee0-0000-1000-8000-00805f9b34fb'] },
        { namePrefix: 'Xiaomi Smart Band' },
        { namePrefix: 'Mi Smart Band' },
        { namePrefix: 'Xiaomi' },
        { namePrefix: 'Mi Band' },
        { namePrefix: 'Smart Band' },
        { namePrefix: 'Band' },
        { namePrefix: 'Mi' },
      ];

      device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: BAND_SERVICE_UUIDS,
      });
      log('info', `[STEP 1a] namePrefix filter ile cihaz seçildi`);
    }

    log('info', `══════════ [STEP 2] CIHAZ BILGILERI ══════════`);
    log('info', `  İsim     : "${device.name ?? '(isimsiz)'}"`);
    log('info', `  ID       : ${device.id}`);
    log('info', `  GATT     : ${device.gatt?.connected ?? false}`);
    log('info', `  GATT obj : ${device.gatt ? 'mevcut' : 'NULL!'}`);
    // @ts-ignore
    const uuids: string[] | undefined = device.uuids;
    if (uuids?.length) {
      log('info', `  Cihaz UUIDs: ${uuids.join(', ')}`);
    } else {
      log('info', `  Cihaz UUIDs: (yok / erişilemedi)`);
    }
    // @ts-ignore
    if (typeof (device as any).watchAdvertisements === 'function') {
      try {
        await (device as any).watchAdvertisements();
        log('info', '  Reklam dinlemesi başlatıldı');
      } catch {}
    }
    log('info', `══════════════════════════════════════════════════`);

    // ──────────────────────────────────────────
    // STEP 3 — GATT CONNECT
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 3] GATT CONNECT ═════`);
    if (!device.gatt) {
      throw new Error('[STEP 3] device.gatt NULL — bluetooth adaptörü kapalı olabilir!');
    }

    try {
      gattServer = await device.gatt.connect();
      log('info', `[STEP 3] GATT server bağlandı: connected=${gattServer.connected}`);
    } catch (errGatt: any) {
      log('error', `[STEP 3] device.gatt.connect() HATA`);
      log('error', `  message  : ${errGatt.message}`);
      log('error', `  code     : ${(errGatt as DOMException).code}`);
      log('error', `  name     : ${(errGatt as DOMException).name}`);
      log('error', `  stack    : ${(errGatt as Error).stack ?? '(yok)'}`);
      throw new Error(`GATT connect failed: ${errGatt.message}`);
    }

    // ──────────────────────────────────────────
    // STEP 4 — ENUMERATE ALL PRIMARY SERVICES
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 4] PRIMARY SERVICELER ═════`);
    let allServices: BluetoothRemoteGATTService[] = [];

    try {
      allServices = await gattServer.getPrimaryServices();
      log('info', `[STEP 4] getPrimaryServices() OK — ${allServices.length} adet service bulundu`);
    } catch (errSvc: any) {
      log('error', `[STEP 4] getPrimaryServices() HATA`);
      log('error', `  message  : ${errSvc.message}`);
      log('error', `  code     : ${(errSvc as DOMException).code}`);
      log('error', `  name     : ${(errSvc as DOMException).name}`);
      log('error', `  stack    : ${(errSvc as Error).stack ?? '(yok)'}`);
      throw new Error(`getPrimaryServices failed: ${errSvc.message}`);
    }

    if (allServices.length === 0) {
      log('warn', `[STEP 4] Hiç service bulunamadı! getPrimaryService(uuid) denenecek…`);
    } else {
      log('info', `[STEP 4] Bulunan tüm serviceler:`);
      for (let i = 0; i < allServices.length; i++) {
        const s = allServices[i];
        const uuid = s.uuid;
        const isPrimary = s.isPrimary ? 'primary' : 'secondary';
        log('info', `  [${i}] UUID=${uuid} (${isPrimary})`);

        // ──────────────────────────────────────────
        // STEP 4a — ENUMERATE CHARACTERISTICS PER SERVICE
        // ──────────────────────────────────────────
        try {
          const chars = await s.getCharacteristics();
          log('info', `        → ${chars.length} characteristic(s):`);
          for (let j = 0; j < chars.length; j++) {
            const c = chars[j];
            const props: string[] = [];
            if (c.properties.read) props.push('read');
            if (c.properties.write) props.push('write');
            if (c.properties.writeWithoutResponse) props.push('writeWithoutResponse');
            if (c.properties.notify) props.push('notify');
            if (c.properties.indicate) props.push('indicate');
            log('info', `          [${j}] ${c.uuid}  [${props.join(', ')}]`);
          }
        } catch (errChar: any) {
          log('warn', `        → getCharacteristics() HATA: ${errChar.message}`);
        }
      }
    }

    // ──────────────────────────────────────────
    // STEP 5 — BUL 0xfee0 SERVICE
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 5] SERVICE 0xfee0 ═════`);

    // Önce enumerated listesinden bulmayı dene
    let fee0Service: BluetoothRemoteGATTService | null = null;

    // Tam ve kısa UUID'leri dene
    const fee0Full = '0000fee0-0000-1000-8000-00805f9b34fb';
    for (const s of allServices) {
      if (s.uuid.toLowerCase() === fee0Full) {
        fee0Service = s;
        log('info', `[STEP 5a] 0xfee0 service enumerated listesinde bulundu`);
        break;
      }
    }

    if (!fee0Service) {
      log('info', `[STEP 5b] Enumerated listesinde 0xfee0 yok, getPrimaryService(uuid) deneniyor…`);
      try {
        fee0Service = await gattServer.getPrimaryService(fee0Full);
        log('info', `[STEP 5b] getPrimaryService(0xfee0) BAŞARILI`);
      } catch (errFee: any) {
        log('error', `[STEP 5b] 0xfee0 servisi BULUNAMADI!`);
        log('error', `  message  : ${errFee.message}`);
        log('error', `  code     : ${(errFee as DOMException).code}`);
        log('error', `  name     : ${(errFee as DOMException).name}`);
        log('error', `  stack    : ${(errFee as Error).stack ?? '(yok)'}`);

        // Fallback: enumerated servislerden ilk uygun olanı dene
        log('warn', `[STEP 5c] 0xfee0 kritik — baglanti kurulamaz. Tüm servis UUID'leri listeleniyor:`);
        for (const s of allServices) {
          log('warn', `  Mevcut service: ${s.uuid}`);
        }
        throw errFee;
      }
    }

    // ──────────────────────────────────────────
    // STEP 6 — 0xfee1 WRITE CHARACTERISTIC
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 6] CHAR 0xfee1 (WRITE) ═════`);
    try {
      writeChar = await fee0Service.getCharacteristic(
        '0000fee1-0000-1000-8000-00805f9b34fb',
      );
      log('info', `[STEP 6] 0xfee1 characteristic alındı`);

      // Özelliklerini logla
      const wProps = writeChar.properties;
      log('info', `  write             : ${wProps.write}`);
      log('info', `  writeWithoutResp  : ${wProps.writeWithoutResponse}`);
      log('info', `  read              : ${wProps.read}`);
    } catch (errW: any) {
      log('error', `[STEP 6] 0xfee1 characteristic HATA`);
      log('error', `  message  : ${errW.message}`);
      log('error', `  code     : ${(errW as DOMException).code}`);
      log('error', `  name     : ${(errW as DOMException).name}`);
      log('error', `  stack    : ${(errW as Error).stack ?? '(yok)'}`);
      throw errW;
    }

    // ──────────────────────────────────────────
    // STEP 7 — 0xfee2 NOTIFY CHARACTERISTIC
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 7] CHAR 0xfee2 (NOTIFY) ═════`);
    try {
      notifyChar = await fee0Service.getCharacteristic(
        '0000fee2-0000-1000-8000-00805f9b34fb',
      );
      log('info', `[STEP 7] 0xfee2 characteristic alındı`);

      const nProps = notifyChar.properties;
      log('info', `  notify   : ${nProps.notify}`);
      log('info', `  indicate  : ${nProps.indicate}`);
      log('info', `  read     : ${nProps.read}`);
    } catch (errN: any) {
      log('error', `[STEP 7] 0xfee2 characteristic HATA`);
      log('error', `  message  : ${errN.message}`);
      log('error', `  code     : ${(errN as DOMException).code}`);
      log('error', `  name     : ${(errN as DOMException).name}`);
      log('error', `  stack    : ${(errN as Error).stack ?? '(yok)'}`);
      throw errN;
    }

    // ──────────────────────────────────────────
    // STEP 8 — START NOTIFICATIONS
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 8] START NOTIFICATIONS ═════`);
    try {
      await notifyChar.startNotifications();
      log('info', `[STEP 8] startNotifications() BAŞARILI`);
    } catch (errNot: any) {
      log('error', `[STEP 8] startNotifications() HATA`);
      log('error', `  message  : ${errNot.message}`);
      log('error', `  code     : ${(errNot as DOMException).code}`);
      log('error', `  name     : ${(errNot as DOMException).name}`);
      log('error', `  stack    : ${(errNot as Error).stack ?? '(yok)'}`);
      throw errNot;
    }

    // ──────────────────────────────────────────
    // STEP 9 — AUTH HANDSHAKE
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 9] AUTH HANDSHAKE ═════`);

    const longTermKey = new Uint8Array(16);
    crypto.getRandomValues(longTermKey);
    log('info', `LongTermKey (demo, random): ${hex(longTermKey)}`);

    // Step 9a: phone → band  AUTH_INIT (opcode 26)
    const phoneNonce = new Uint8Array(16);
    crypto.getRandomValues(phoneNonce);
    log('info', `Phone nonce: ${hex(phoneNonce)}`);

    const initFrame = new Uint8Array(25);
    initFrame[0] = 100;
    initFrame[1] = 1;
    initFrame[2] = 26;
    initFrame[3] = 0x0a;
    initFrame[4] = 16;
    initFrame.set(phoneNonce, 5);
    log('sent', `AUTH_INIT → ${hex(initFrame)}`);

    try {
      await writeChar.writeValue(initFrame);
      log('info', `[STEP 9a] AUTH_INIT gönderildi`);
    } catch (errWv: any) {
      log('error', `[STEP 9a] writeValue(AUTH_INIT) HATA`);
      log('error', `  message  : ${errWv.message}`);
      log('error', `  code     : ${(errWv as DOMException).code}`);
      log('error', `  name     : ${(errWv as DOMException).name}`);
      log('error', `  stack    : ${(errWv as Error).stack ?? '(yok)'}`);
      throw errWv;
    }

    // Step 9b: band → phone  AUTH_RESPONSE (opcode 27 expected)
    log('info', `[STEP 9b] AUTH_RESPONSE bekleniyor…`);
    let authResp: Uint8Array;
    try {
      authResp = await waitOneNotification(10000);
      log('recv', `AUTH_RESPONSE ← ${hex(authResp)}`);
    } catch (errTo: any) {
      log('error', `[STEP 9b] AUTH_RESPONSE zamanaşımı/hatası`);
      log('error', `  message  : ${errTo.message}`);
      log('error', `  stack    : ${(errTo as Error).stack ?? '(yok)'}`);
      throw errTo;
    }

    if (authResp.length < 3) {
      throw new Error(`Auth response too short: ${authResp.length}B`);
    }
    const [rType, rCat, rOp] = authResp;
    log('info',
      `Response header: type=${rType}  cat=${rCat}  opcode=${rOp}  payload=${authResp.length - 3}B`);

    setStatus('Authenticated ✓', true);
    log('info', '=== AUTH COMPLETE ===');

    // ──────────────────────────────────────────
    // STEP 10 — BATTERY
    // ──────────────────────────────────────────
    log('info', `═════ [STEP 10] BATTERY ═════`);
    const batReq = new Uint8Array(3);
    batReq[0] = 100; batReq[1] = 5; batReq[2] = 12;
    log('sent', `BATTERY_REQ → ${hex(batReq)}`);

    try {
      await writeChar.writeValue(batReq);
    } catch (errBat: any) {
      log('error', `BATTERY_REQ write HATA (pas geçiliyor): ${errBat.message}`);
    }

    try {
      const batResp = await waitOneNotification(5000);
      log('recv', `BATTERY_RESP ← ${hex(batResp)}`);
      if (batResp.length >= 4) {
        const level    = batResp[3];
        const charging = batResp.length > 4 ? batResp[4] === 1 : false;
        valBattery.textContent = `${level}`;
        valCharging.textContent = charging ? 'Charging' : 'Not charging';
        panelBattery.style.display = 'block';
        log('info', `Battery: ${level}%  ${charging ? '(charging)' : ''}`);
      }
    } catch {
      log('warn', 'BATTERY_RESP alınamadı (pas geçiliyor)');
    }

    // ── Ready ──
    btnHrStart.disabled = false;
    setStatus('Ready ✓', true);
    log('info', '══════════ DEVICE READY ══════════');

  } catch (err: any) {
    // ── FULL ERROR REPORT ──
    const errCode = (err as DOMException).code;
    const errName = (err as DOMException).name;
    log('error', `══════════ HATA ══════════`);
    log('error', `  message  : ${err.message ?? err}`);
    log('error', `  code     : ${errCode}`);
    log('error', `  name     : ${errName}`);
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
