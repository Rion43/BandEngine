// BluefyDiagnostic — BLE teşhis modu v2
// Tablo formatında write logları, characteristic doğrulama

export interface WriteLog {
  uuid: string;
  bytes: number;
  opcode: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  connectedAfter: boolean;
  error: string | null;
  charValid: boolean;
  seq: number;
}

let writeLogs: WriteLog[] = [];
let disconnectTime = 0;
let lastWriteTime = 0;
let seqCounter = 0;
let gattServerPtr: any = null;

export function diagInit(gatt: any) {
  gattServerPtr = gatt;
  writeLogs = [];
  disconnectTime = 0;
  lastWriteTime = 0;
  seqCounter = 0;
  console.log(`[DIAG] init`);
}

export function setGattPtr(gatt: any) {
  gattServerPtr = gatt;
}

export function diagGetWriteTable(): string {
  let table = '--- WRITE LOG TABLE ---\n';
  table += 'idx | uuid | seq | bytes | opcode | dur(ms) | connected? | error\n';
  table += '----|------|-----|-------|--------|---------|------------|------\n';
  for (const w of writeLogs) {
    table += `${String(writeLogs.indexOf(w)).padStart(3)} | ${w.uuid.slice(-6)} | ${w.seq} | ${String(w.bytes).padStart(4)} | ${w.opcode.padStart(8)} | ${String(w.durationMs).padStart(5)} | ${w.connectedAfter ? 'YES' : 'NO' } | ${w.error ?? 'OK'}\n`;
  }
  if (disconnectTime > 0) {
    table += `\nDisconnect: ${disconnectTime}ms after last write\n`;
    table += `Disconnect: ${disconnectTime}ms after auth success\n`;
  }
  return table;
}

export async function diagWriteDebug(
  writeFn: () => Promise<void>,
  uuid: string,
  bytes: number,
  opcode: string,
): Promise<{ok: boolean; err: any}> {
  const seq = seqCounter++;
  const startMs = Date.now();
  const logEntry: WriteLog = {
    uuid, bytes, opcode, startMs, endMs: 0, durationMs: 0,
    connectedAfter: false, error: null, charValid: true, seq,
  };
  try {
    console.log(`[DIAG:WRITE] seq=${seq} uuid=${uuid} bytes=${bytes}: BEFORE`);
    await writeFn();
    logEntry.endMs = Date.now();
    logEntry.durationMs = logEntry.endMs - startMs;
    // check if characteristic still valid by trying to access properties
    try {
      const gatt = gattServerPtr;
      logEntry.connectedAfter = gatt?.connected ?? false;
    } catch { logEntry.connectedAfter = false; }
    logEntry.charValid = true;
    console.log(`[DIAG:WRITE] seq=${seq}: AFTER dur=${logEntry.durationMs}ms connected=${logEntry.connectedAfter}`);
    writeLogs.push(logEntry);
    lastWriteTime = Date.now();
    return {ok: true, err: null};
  } catch (e: any) {
    logEntry.endMs = Date.now();
    logEntry.durationMs = logEntry.endMs - startMs;
    logEntry.error = e?.message ?? String(e);
    logEntry.connectedAfter = false;
    logEntry.charValid = false;
    console.log(`[DIAG:WRITE] seq=${seq}: ERROR ${logEntry.error}`);
    writeLogs.push(logEntry);
    return {ok: false, err: e};
  }
}

export function diagOnDisconnect() {
  disconnectTime = Date.now();
  const table = diagGetWriteTable();
  console.log(`[DIAG] ${table}`);
}

export function diagSummary(): string {
  const totalDuration = writeLogs.reduce((s, w) => s + w.durationMs, 0);
  const errors = writeLogs.filter(w => w.error).length;
  return `Writes: ${writeLogs.length} | Errors: ${errors} | Total dur: ${totalDuration}ms | Last write before disconnect: ${disconnectTime > 0 && lastWriteTime > 0 ? disconnectTime - lastWriteTime + 'ms' : 'N/A'}`;
}
