// SppSystemMessages — Gadgetbridge-style System/Clock protobuf messages
// Birebir xiaomi.proto + XiaomiSystemService.java

function encodeVarint(val: number): Uint8Array {
  if (val < 0x80) return new Uint8Array([val]);
  const bytes: number[] = [];
  while (val >= 0x80) { bytes.push((val & 0x7f) | 0x80); val >>>= 7; }
  bytes.push(val & 0x7f);
  return new Uint8Array(bytes);
}

function tag(fieldNum: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNum << 3) | wireType);
}

function lenDel(fieldNum: number, data: Uint8Array): Uint8Array {
  const t = tag(fieldNum, 2);
  const l = encodeVarint(data.length);
  const out = new Uint8Array(t.length + l.length + data.length);
  out.set(t, 0);
  out.set(l, t.length);
  out.set(data, t.length + l.length);
  return out;
}

function varint(fieldNum: number, val: number): Uint8Array {
  const t = tag(fieldNum, 0);
  const v = encodeVarint(val);
  const out = new Uint8Array(t.length + v.length);
  out.set(t, 0);
  out.set(v, t.length);
  return out;
}

function sint32(fieldNum: number, val: number): Uint8Array {
  const zigzag = (val << 1) ^ (val >> 31);
  return varint(fieldNum, zigzag >>> 0);
}

function boolF(fieldNum: number, val: boolean): Uint8Array {
  return varint(fieldNum, val ? 1 : 0);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/**
 * Encode Command{type=2, subtype=3, system{clock{date,time,timezone,isNot24hour}}}
 * Birebir XiaomiSystemService.setCurrentTime() + xiaomi.proto
 */
export function encodeCommandClock(): Uint8Array {
  const now = new Date();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzBytes = new TextEncoder().encode(tzName);
  const offsetMin = -now.getTimezoneOffset();
  const zoneOff = Math.round(offsetMin / 15); // 15-min blocks

  // Date { year=1, month=2, day=3 }
  const dateMsg = concat(
    varint(1, now.getFullYear()),
    varint(2, now.getMonth() + 1),
    varint(3, now.getDate()),
  );

  // Time { hour=1, minute=2, second=3, millisecond=4 }
  const timeMsg = concat(
    varint(1, now.getHours()),
    varint(2, now.getMinutes()),
    varint(3, now.getSeconds()),
    varint(4, now.getMilliseconds()),
  );

  // TimeZone { zoneOffset=1(sint32), dstOffset=2(sint32), name=3(string) }
  const tzMsg = concat(
    sint32(1, zoneOff),
    sint32(2, 0), // dstOffset = 0
    lenDel(3, tzBytes),
  );

  // Clock = date(1) + time(2) + timezone(3) + isNot24hour(4)
  const clockMsg = concat(
    lenDel(1, dateMsg),
    lenDel(2, timeMsg),
    lenDel(3, tzMsg),
    boolF(4, false),
  );

  // System { clock(4) }
  const sysMsg = lenDel(4, clockMsg);

  // Command { type(1)=2, subtype(2)=3, system(4) }
  return concat(
    varint(1, 2),
    varint(2, 3),
    lenDel(4, sysMsg),
  );
}
