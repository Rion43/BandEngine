// SppSystemMessages — Gadgetbridge-style System/Clock protobuf messages
// Wire format based on xiaomi.proto + XiaomiSystemService.java

import { toHex } from './SppAuthMessages.js';
export { toHex };

// ── Protobuf helpers ──

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

function lenDelimited(fieldNum: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNum, 2);
  const len = encodeVarint(data.length);
  const out = new Uint8Array(tag.length + len.length + data.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(data, tag.length + len.length);
  return out;
}

function varintField(fieldNum: number, val: number): Uint8Array {
  const tag = encodeTag(fieldNum, 0);
  const v = encodeVarint(val);
  const out = new Uint8Array(tag.length + v.length);
  out.set(tag, 0);
  out.set(v, tag.length);
  return out;
}

function sint32Field(fieldNum: number, val: number): Uint8Array {
  // Zig-zag encode
  const zigzag = (val << 1) ^ (val >> 31);
  return varintField(fieldNum, zigzag >>> 0);
}

function boolField(fieldNum: number, val: boolean): Uint8Array {
  return varintField(fieldNum, val ? 1 : 0);
}

export function encodeCommandClock(): Uint8Array {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const offsetMin = -now.getTimezoneOffset();
  const zoneOffset = Math.round(offsetMin / 15); // 15min blocks

  // Clock: date{1=year,2=month,3=day} time{1=hour,2=min,3=sec,4=ms} timezone{1=zoneOffset,2=dstOffset,3=name} 4=isNot24hour
  const dateFields = new Uint8Array([
    ...varintField(1, now.getFullYear()),
    ...varintField(2, now.getMonth() + 1),
    ...varintField(3, now.getDate()),
  ]);
  const dateMsg = lenDelimited(1, dateFields);
  const dateLen = encodeVarint(dateFields.length);
  const dateProto = new Uint8Array(1 + dateLen.length + dateFields.length);
  dateProto[0] = (1 << 3) | 2; // field 1, wire 2
  dateProto.set(dateLen, 1);
  dateProto.set(dateFields, 1 + dateLen.length);

  const timeFields = new Uint8Array([
    ...varintField(1, now.getHours()),
    ...varintField(2, now.getMinutes()),
    ...varintField(3, now.getSeconds()),
    ...varintField(4, now.getMilliseconds()),
  ]);
  const timeLen = encodeVarint(timeFields.length);
  const timeProto = new Uint8Array(1 + timeLen.length + timeFields.length);
  timeProto[0] = (2 << 3) | 2; // field 2, wire 2
  timeProto.set(timeLen, 1);
  timeProto.set(timeFields, 1 + timeLen.length);

  const tzName = new TextEncoder().encode(tz);
  const tzFields = new Uint8Array([
    ...sint32Field(1, zoneOffset),
    ...sint32Field(2, 0), // dstOffset = 0
    ...lenDelimited(3, tzName),
  ]);
  const tzLen = encodeVarint(tzFields.length);
  const tzProto = new Uint8Array(1 + tzLen.length + tzFields.length);
  tzProto[0] = (3 << 3) | 2; // field 3, wire 2
  tzProto.set(tzLen, 1);
  tzProto.set(tzFields, 1 + tzLen.length);

  const isNot24hour = boolField(4, false);

  // Clock message = concat dateProto + timeProto + tzProto + isNot24hour
  const clockBody = new Uint8Array(dateProto.length + timeProto.length + tzProto.length + isNot24hour.length);
  clockBody.set(dateProto, 0);
  clockBody.set(timeProto, dateProto.length);
  clockBody.set(tzProto, dateProto.length + timeProto.length);
  clockBody.set(isNot24hour, dateProto.length + timeProto.length + tzProto.length);

  // System { clock = 4 }
  const systemBody = lenDelimited(4, clockBody);
  // Command { type=2, subtype=3, system=4 }
  const cmdType = varintField(1, 2);
  const cmdSubtype = varintField(2, 3);
  const cmdSystem = lenDelimited(4, systemBody);
  const out = new Uint8Array(cmdType.length + cmdSubtype.length + cmdSystem.length);
  out.set(cmdType, 0);
  out.set(cmdSubtype, cmdType.length);
  out.set(cmdSystem, cmdType.length + cmdSubtype.length);

  console.log(`[SystemMessages] Clock cmd (${out.length}B): ${toHex(out)}`);
  return out;
}
