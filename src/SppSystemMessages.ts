// SppSystemMessages — Gadgetbridge-style System/Clock protobuf messages
// protobufjs kullanir, xiaomi.proto ile birebir Gadgetbridge protobuf

import protobuf from 'protobufjs';

// Proto defs — Gadgetbridge xiaomi.proto (sadece ihtiyac duyulan kisim)
const PROTO_DEF = `
syntax = "proto2";
package xiaomi;

message Command {
  required uint32 type = 1;
  optional uint32 subtype = 2;
  optional System system = 4;
}

message System {
  optional Clock clock = 4;
}

message Clock {
  required Date date = 1;
  required Time time = 2;
  required TimeZone timezone = 3;
  optional bool isNot24hour = 4;
}

message Date {
  required uint32 year = 1;
  required uint32 month = 2;
  required uint32 day = 3;
}

message Time {
  required uint32 hour = 1;
  required uint32 minute = 2;
  optional uint32 second = 3;
  optional uint32 millisecond = 4;
}

message TimeZone {
  optional sint32 zoneOffset = 1;
  optional sint32 dstOffset = 2;
  required string name = 3;
}
`;

const root = protobuf.parse(PROTO_DEF).root;
const Command = root.lookupType('xiaomi.Command');
const Clock = root.lookupType('xiaomi.Clock');

function buildDate(now: Date): any {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function buildTime(now: Date): any {
  return { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds(), millisecond: now.getMilliseconds() };
}

function buildTimezone(): any {
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = -new Date().getTimezoneOffset();
  return { zoneOffset: Math.round(offsetMin / 15), dstOffset: 0, name: tzName };
}

export function encodeCommandClock(): Uint8Array {
  const now = new Date();
  const clockMsg = Clock.create({
    date: buildDate(now),
    time: buildTime(now),
    timezone: buildTimezone(),
    isNot24hour: false,
  });
  const msg = Command.create({ type: 2, subtype: 3, system: { clock: clockMsg } });
  const buf = Command.encode(msg).finish();
  console.log(`[SystemMessages] Clock protobufjs (${buf.length}B): ${toHex(buf)}`);
  return buf;
}

export function encodeCommandDeviceInfo(): Uint8Array {
  const msg = Command.create({ type: 2, subtype: 2 });
  const buf = Command.encode(msg).finish();
  console.log(`[SystemMessages] DeviceInfo GET (${buf.length}B): ${toHex(buf)}`);
  return buf;
}

export function encodeCommandBattery(): Uint8Array {
  const msg = Command.create({ type: 2, subtype: 1 });
  const buf = Command.encode(msg).finish();
  return buf;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
