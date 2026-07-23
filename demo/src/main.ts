import './style.css';
import { log, hex as hexLog } from './logger.js';
import { SppPacketV2, SppPacketType, SppChannel, SppDataOpcode } from '../../src/SppPacketV2.js';
import { SppAuthProtocol } from '../../src/SppAuthProtocol.js';
import { SppAckTracker } from '../../src/SppAckTracker.js';
import { toHex } from '../../src/SppAuthMessages.js';

const VERSION = '5.9-clock-deviceinfo';

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
      // Send ACK immediately
      writeBLE(SppPacketV2.buildAck(pkt.sequenceNumber)).catch(() => {});
      const ch = SppChannel[pkt.channel ?? -1] ?? '?';
      log('recv', `DATA ch=${ch} op=${SppDataOpcode[pkt.opcode ?? 0]} payload(${pkt.payload.length}B)`);

      // Route to auth handler if waiting
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
  return new Promise((resolve) => {
    if (authResolve) authResolve(null);
    const t = setTimeout(() => { authResolve = null; log('warn', `⏱ ${label} timeout ${timeoutMs}ms`); resolve(null); }, timeoutMs);
    authResolve = (p) => { clearTimeout(t); authResolve = null; resolve(p); };
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
  ltkChars.parentElement!.className = 'wizard-counter' + (raw.length === 32 ? ' full
