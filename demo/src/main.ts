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
  try {
    setStatus('Pairing…');
    btnConnect.disabled = true;
    log('info', 'Requesting Bluetooth device…');

    // ── Geniş BLE taraması ──
    // Önce acceptAllDevices dener, olmazsa namePrefix filterlerine düşer.
    const filterNames = [
      'Xiaomi Smart Band',
      'Mi Smart Band',
      'Xiaomi',
      'Mi Band',
      'Smart Band',
      'Band',
      'Mi',
    ];
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
    log('info', `BLE taraması başlıyor — filter'lar: ${filterNames.join(' | ')}`);
    log('info', 'Browser cihaz seçim penceresi açılacak. acceptAllDevices deneniyor…');

    let device: BluetoothDevice;
    try {
      // acceptAllDevices → tüm BLE cihazlarını göster
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          '0000fee0-0000-1000-8000-00805f9b34fb',
          '0000fee1-0000-1000-8000-00805f9b34fb',
          '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
        ],
      });
      log('info', 'acceptAllDevices ile cihaz seçildi');
    } catch (_errA) {
      log('warn', `acceptAllDevices başarısız (${(_errA as Error).message}), namePrefix filter'larına düşülüyor…`);
      device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: [
          '0000fee0-0000-1000-8000-00805f9b34fb',
          '0000fee1-0000-1000-8000-00805f9b34fb',
          '0000180a-0000-1000-8000-00805f9b34fb',
        ],
      });
    }

    // ── Seçilen cihazı logla ──
    log('info', `══════════ CIHAZ SEÇİLDİ ══════════`);
    log('info', `  İsim     : "${device.name ?? '(isimsiz)'}"`);
    log('info', `  ID       : ${device.id}`);
    log('info', `  GATT     : ${device.gatt?.connected ?? false}`);
    // @ts-ignore — some browsers expose uuids on the device object
    const uuids: string[] | undefined = device.uuids;
    if (uuids?.length) {
      log('info', `  UUIDs    : ${uuids.join(', ')}`);
    }
    // @ts-ignore — watchAdvertisements
    if (typeof (device as any).watchAdvertisements === 'function') {
      try {
        await (device as any).watchAdvertisements();
        log('info', '  Reklam dinlemesi başlatıldı');
      } catch {}
    }
    log('info', `══════════════════════════════════`);

    setStatus('Connecting…');
    gattServer = await device.gatt!.connect();
    log('info', 'GATT server connected');

    const svc = await gattServer.getPrimaryService(
      '0000fee0-0000-1000-8000-00805f9b34fb',
    );
    log('info', 'Service 0xfee0 acquired');

    writeChar = await svc.getCharacteristic(
      '0000fee1-0000-1000-8000-00805f9b34fb',
    );
    notifyChar = await svc.getCharacteristic(
      '0000fee2-0000-1000-8000-00805f9b34fb',
    );
    await notifyChar.startNotifications();
    log('info', 'Notifications started on 0xfee2');

    // ── Authentication handshake (opcodes 26-28) ──
    log('info', '=== AUTH HANDSHAKE ===');

    const longTermKey = new Uint8Array(16);
    crypto.getRandomValues(longTermKey);
    log('info', `LongTermKey (demo, random): ${hex(longTermKey)}`);

    // Step 1: phone → band  AUTH_INIT (opcode 26)
    const phoneNonce = new Uint8Array(16);
    crypto.getRandomValues(phoneNonce);
    log('info', `Phone nonce: ${hex(phoneNonce)}`);

    // Wire format: type(1) cat(1) op(1) [protobuf payload]
    // protobuf: tag=0x0a (field 1, bytes), len=16, data=phoneNonce
    const initFrame = new Uint8Array(25);
    initFrame[0] = 100;                   // type = PLAINTEXT
    initFrame[1] = 1;                     // category = SYSTEM
    initFrame[2] = 26;                    // opcode = AUTH_INIT
    initFrame[3] = 0x0a;                 // tag field 1 bytes
    initFrame[4] = 16;                   // length
    initFrame.set(phoneNonce, 5);
    // bytes 21-24 are a 4-byte field that Mi Fitness sends (count/seq?)
    log('sent', `AUTH_INIT → ${hex(initFrame)}`);
    await writeChar.writeValue(initFrame);

    // Step 2: band → phone  AUTH_RESPONSE (opcode 27 expected)
    const authResp = await waitOneNotification(10000);
    log('recv', `AUTH_RESPONSE ← ${hex(authResp)}`);

    if (authResp.length < 3) {
      throw new Error(`Auth response too short: ${authResp.length}B`);
    }
    const [rType, rCat, rOp] = authResp;
    log('info',
      `Response header: type=${rType}  cat=${rCat}  opcode=${rOp}  payload=${authResp.length - 3}B`);

    // Full production path would:
    //   1. Parse protobuf → { bandNonce, signature }
    //   2. HKDF-HMAC-SHA256(LTK, phoneNonce||bandNonce, "miwear-auth") → 64B
    //   3. Verify signature with MAC key
    //   4. Send AUTH_CONFIRM
    // For this demo any timely response is accepted as success.
    setStatus('Authenticated ✓', true);
    log('info', '=== AUTH COMPLETE ===');

    // ── Read Battery (opcode 12) ──
    log('info', '=== BATTERY ===');
    const batReq = new Uint8Array(3);
    batReq[0] = 100; batReq[1] = 5; batReq[2] = 12;
    log('sent', `BATTERY_REQ → ${hex(batReq)}`);
    await writeChar.writeValue(batReq);

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

    // ── Ready ──
    btnHrStart.disabled = false;
    setStatus('Ready ✓', true);
    log('info', '=== DEVICE READY ===');
  } catch (err: any) {
    log('error', `Connect failed: ${err.message ?? err}`);
    setStatus(`Error: ${err.message ?? err}`, false);
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
    pkt[0] = 101; pkt[1] = 2; pkt[2] = 69;   // type=encrypted, cat=HEALTH, op=HR_SUBSCRIBE
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
    pkt[0] = 101; pkt[1] = 2; pkt[2] = 70;   // type=encrypted, cat=HEALTH, op=HR_UNSUBSCRIBE
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
