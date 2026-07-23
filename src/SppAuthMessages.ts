// SppAuthMessages — Gadgetbridge-style auth protobuf messages
// Wire format based on XiaomiAuthService.java

import { toHex } from './SppAuthCrypto.js';
export { toHex };

// ── Protobuf varint helpers ──

function encodeTag(fieldNum: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeVarint(val: number): Uint8Array {
  if (val < 0x80) return new Uint8Array([val]);
  const bytes: number[] = [];
  while (val >= 0x80) { bytes.push((val & 0x7f) | 0x80); val >>>= 7; }
  bytes.push(val & 0x7f);
  return new Uint8Array(bytes);
}

/** Build a length-delimited protobuf field: tag || varint(len) || data */
function lenDelimited(fieldNum: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNum, 2);
  const len = encodeVarint(data.length);
  const out = new Uint8Array(tag.length + len.length + data.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(data, tag.length + len.length);
  return out;
}

/** Build a varint field: tag || varint(value) */
function varintField(fieldNum: number, val: number): Uint8Array {
  const tag = encodeTag(fieldNum, 0);
  const v = encodeVarint(val);
  const out = new Uint8Array(tag.length + v.length);
  out.set(tag, 0);
  out.set(v, tag.length);
  return out;
}

/** Build a fixed32 field: tag || 4-byte LE */
function fixed32Field(fieldNum: number, val: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNum, 5);
  const out = new Uint8Array(tag.length + 4);
  out.set(tag, 0);
  out.set(val, tag.length);
  return out;
}

function readVarint(data: Uint8Array, i: number): { value: number; next: number } | null {
  let val = 0, shift = 0;
  while (i < data.length) {
    const b = data[i++];
    val |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) return { value: val, next: i };
  }
  return null;
}

function findField(data: Uint8Array, fieldNum: number): Uint8Array | null {
  let i = 0;
  while (i < data.length) {
    const tag = readVarint(data, i);
    if (!tag) return null;
    const fn = tag.value >> 3, wt = tag.value & 0x07;
    i = tag.next;
    if (fn === fieldNum && wt === 2) {
      const len = readVarint(data, i);
      if (!len || i + len.value > data.length) return null;
      return data.slice(len.next, len.next + len.value);
    }
    if (wt === 0) { const v = readVarint(data, i); if (!v) return null; i = v.next; }
    else if (wt === 1) { i += 8; }
    else if (wt === 2) { const len = readVarint(data, i); if (!len) return null; i = len.next + len.value; }
    else if (wt === 5) { i += 4; }
    else return null;
  }
  return null;
}

function skipField(data: Uint8Array, i: number): number {
  const tag = readVarint(data, i);
  if (!tag) return data.length;
  const wt = tag.value & 0x07;
  i = tag.next;
  switch (wt) {
    case 0: { const v = readVarint(data, i); return v ? v.next : data.length; }
    case 1: return i + 8;
    case 2: { const len = readVarint(data, i); return len ? len.next + len.value : data.length; }
    case 5: return i + 4;
    default: return data.length;
  }
}

// ── PhoneNonce (CMD_NONCE=26) ──

export function encodeCommandPhoneNonce(nonce: Uint8Array): Uint8Array {
  // PhoneNonce { nonce(f1) } -> Auth{f30} -> Command{f1=type, f2=subtype, f3=auth}
  const phoneNonce = lenDelimited(1, nonce);
  const auth = lenDelimited(30, phoneNonce);
  // Command: type=1, subtype=26, auth=...
  const cmdAuth = lenDelimited(3, auth);
  const out = new Uint8Array(4 + cmdAuth.length);
  out.set(varintField(1, 1), 0);      // type = 1
  out.set(varintField(2, 26), 2);     // subtype = 26
  out.set(cmdAuth, 4);
  return out;
}

// ── WatchNonce decoder ──

export interface WatchNonceResult { nonce: Uint8Array; hmac: Uint8Array; }

export function decodeWatchNonce(payload: Uint8Array): WatchNonceResult | null {
  const authBytes = findField(payload, 3);
  if (!authBytes) { console.warn(`[decodeWatchNonce] no Auth (field 3)`); return null; }
  const wnBytes = findField(authBytes, 31);
  if (!wnBytes) { console.warn(`[decodeWatchNonce] no WatchNonce (field 31)`); return null; }
  let nonce: Uint8Array | null = null, hmac: Uint8Array | null = null, i = 0;
  while (i < wnBytes.length) {
    const tag = readVarint(wnBytes, i);
    if (!tag) break;
    const fn = tag.value >> 3, wt = tag.value & 0x07;
    i = tag.next;
    if (wt !== 2) { i = skipField(wnBytes, i - (tag.next - i) - 1); continue; }
    const len = readVarint(wnBytes, i);
    if (!len || i + len.value > wnBytes.length) break;
    i = len.next;
    const val = wnBytes.slice(i, i + len.value);
    i += len.value;
    if (fn === 1) nonce = val;
    else if (fn === 2) hmac = val;
  }
  if (nonce && hmac) return { nonce, hmac };
  console.warn(`[decodeWatchNonce] missing nonce or hmac`);
  return null;
}

// ── AuthDeviceInfo ──

export function encodeAuthDeviceInfo(apiLevel: number, phoneName: string, region: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(phoneName);
  const regionBytes = new TextEncoder().encode(region);

  // phoneApiLevel as float32 (fixed32)
  const apiLevelBytes = new Uint8Array(4);
  new DataView(apiLevelBytes.buffer).setFloat32(0, apiLevel, true);

  const fields = [
    varintField(1, 0),                       // unknown1 = 0
    fixed32Field(2, apiLevelBytes),          // phoneApiLevel
    lenDelimited(3, nameBytes),              // phoneName
    varintField(4, 224),                     // unknown3 = 224
    lenDelimited(5, regionBytes),            // region
  ];

  const totalLen = fields.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const f of fields) { out.set(f, off); off += f.length; }
  return out;
}

// ── AuthStep3 (CMD_AUTH=27) ──

export function encodeAuthStep3Payload(encryptedNonces: Uint8Array, encryptedDeviceInfo: Uint8Array): Uint8Array {
  const f1 = lenDelimited(1, encryptedNonces);
  const f2 = lenDelimited(2, encryptedDeviceInfo);
  const out = new Uint8Array(f1.length + f2.length);
  out.set(f1, 0);
  out.set(f2, f1.length);
  return out;
}

export function encodeCommandAuthStep3(authStep3: Uint8Array): Uint8Array {
  // Auth{f32=authStep3} -> Command{f1=type, f2=subtype, f3=auth}
  const auth = lenDelimited(32, authStep3);
  const cmdAuth = lenDelimited(3, auth);
  const out = new Uint8Array(4 + cmdAuth.length);
  out.set(varintField(1, 1), 0);
  out.set(varintField(2, 27), 2);
  out.set(cmdAuth, 4);
  return out;
}

// ── Auth response status decoder ──

export interface AuthResponse { status: number; success: boolean; }

/** Extract subtype (field 2, varint) from Command */
function getSubtype(payload: Uint8Array): number | null {
  let i = 0;
  while (i < payload.length) {
    const tag = readVarint(payload, i);
    if (!tag) return null;
    const fn = tag.value >> 3, wt = tag.value & 0x07;
    i = tag.next;
    if (fn === 2 && wt === 0) {
      const v = readVarint(payload, i);
      if (!v) return null;
      return v.value;
    }
    if (wt === 0) { const v = readVarint(payload, i); if (!v) return null; i = v.next; }
    else if (wt === 1) { i += 8; }
    else if (wt === 2) { const len = readVarint(payload, i); if (!len) return null; i = len.next + len.value; }
    else if (wt === 5) { i += 4; }
    else return null;
  }
  return null;
}

/**
 * Decode auth response from Command payload.
 * Success = subtype=27 (CMD_AUTH) OR auth.status=1 (Gadgetbridge rule)
 */
export function decodeAuthResponse(payload: Uint8Array): AuthResponse | null {
  const subtype = getSubtype(payload);
  if (subtype !== null && subtype === 27) {
    // CMD_AUTH response = always success (Gadgetbridge rule)
    return { status: 1, success: true };
  }

  const authBytes = findField(payload, 3);
  if (!authBytes) {
    if (payload.length >= 2 && payload[0] === 0x08) return { status: payload[1], success: payload[1] === 1 };
    return null;
  }
  let i = 0;
  while (i < authBytes.length) {
    const tag = readVarint(authBytes, i);
    if (!tag) break;
    const fn = tag.value >> 3, wt = tag.value & 0x07;
    i = tag.next;
    if (fn === 1 && wt === 0) {
      const v = readVarint(authBytes, i);
      if (!v) return null;
      return { status: v.value, success: v.value === 1 };
    }
    i = skipField(authBytes, i);
  }
  return null;
}
