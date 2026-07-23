// SppAuthMessages — Gadgetbridge-style auth protobuf messages
// Wire format based on XiaomiAuthService.java protobuf:
//   Command { type(f1), subtype(f2), auth(f3) }
//   Auth { phoneNonce(f30), watchNonce(f31), authStep3(f32), status(f1) }
//   PhoneNonce { nonce(f1) }
//   WatchNonce { nonce(f1), hmac(f2) }
//   AuthStep3 { encryptedNonces(f1), encryptedDeviceInfo(f2) }
//   AuthDeviceInfo { unknown1(f1), phoneApiLevel(f2), phoneName(f3), unknown3(f4), region(f5) }
import { toHex } from './SppAuthCrypto.js';
export { toHex };
// ── Protobuf varint helpers ──
/** Encode a field tag: (fieldNum << 3) | wireType as varint */
function encodeTag(fieldNum, wireType) {
    const val = (fieldNum << 3) | wireType;
    return encodeVarint(val);
}
function encodeVarint(val) {
    const bytes = [];
    while (val >= 0x80) {
        bytes.push((val & 0x7f) | 0x80);
        val >>>= 7;
    }
    bytes.push(val & 0x7f);
    return new Uint8Array(bytes);
}
/** Read a full varint from data starting at i, return {value, nextIndex} */
function readVarint(data, i) {
    let val = 0;
    let shift = 0;
    while (i < data.length) {
        const b = data[i++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80))
            return { value: val, next: i };
    }
    return null;
}
/**
 * Find a length-delimited (wire type 2) field by field number.
 * Properly handles multi-byte varint tags.
 */
function findField(data, fieldNum) {
    let i = 0;
    while (i < data.length) {
        const tag = readVarint(data, i);
        if (!tag)
            return null;
        const fn = tag.value >> 3;
        const wt = tag.value & 0x07;
        i = tag.next;
        if (fn === fieldNum && wt === 2) {
            const len = readVarint(data, i);
            if (!len || i + len.value > data.length)
                return null;
            return data.slice(len.next, len.next + len.value);
        }
        // skip field
        if (wt === 0) { // varint
            const v = readVarint(data, i);
            if (!v)
                return null;
            i = v.next;
        }
        else if (wt === 1) { // fixed64
            i += 8;
        }
        else if (wt === 2) { // length-delimited
            const len = readVarint(data, i);
            if (!len)
                return null;
            i = len.next + len.value;
        }
        else if (wt === 5) { // fixed32
            i += 4;
        }
        else {
            return null;
        }
    }
    return null;
}
function skipField(data, i) {
    const tag = readVarint(data, i);
    if (!tag)
        return data.length;
    const wt = tag.value & 0x07;
    i = tag.next;
    switch (wt) {
        case 0: {
            const v = readVarint(data, i);
            return v ? v.next : data.length;
        }
        case 1: return i + 8;
        case 2: {
            const len = readVarint(data, i);
            return len ? len.next + len.value : data.length;
        }
        case 5: return i + 4;
        default: return data.length;
    }
}
// ── PhoneNonce (CMD_NONCE=26) ──
export function encodeCommandPhoneNonce(nonce) {
    // PhoneNonce field 1 = nonce (bytes)
    const pnTag = encodeTag(1, 2);
    const pnInner = new Uint8Array(pnTag.length + 1 + nonce.length);
    pnInner.set(pnTag, 0);
    pnInner[pnTag.length] = nonce.length;
    pnInner.set(nonce, pnTag.length + 1);
    // Auth field 30 = phoneNonce
    const authTag = encodeTag(30, 2);
    const authPayload = new Uint8Array(authTag.length + 1 + pnInner.length);
    authPayload.set(authTag, 0);
    authPayload[authTag.length] = pnInner.length;
    authPayload.set(pnInner, authTag.length + 1);
    // Command field 3 = auth
    const cmdAuthTag = encodeTag(3, 2);
    const cmdAuth = new Uint8Array(cmdAuthTag.length + 1 + authPayload.length);
    cmdAuth.set(cmdAuthTag, 0);
    cmdAuth[cmdAuthTag.length] = authPayload.length;
    cmdAuth.set(authPayload, cmdAuthTag.length + 1);
    // Command: type=1 (field 1 varint), subtype=26 (field 2 varint)
    const typeTag = encodeTag(1, 0);
    const subTag = encodeTag(2, 0);
    const out = new Uint8Array(typeTag.length + 1 + subTag.length + 1 + cmdAuth.length);
    let off = 0;
    out.set(typeTag, off);
    off += typeTag.length;
    out[off++] = 1; // COMMAND_TYPE
    out.set(subTag, off);
    off += subTag.length;
    out[off++] = 26; // CMD_NONCE
    out.set(cmdAuth, off);
    return out;
}
export function decodeWatchNonce(payload) {
    const authBytes = findField(payload, 3);
    if (!authBytes) {
        console.warn(`[decodeWatchNonce] no Auth (field 3)`);
        return null;
    }
    const wnBytes = findField(authBytes, 31);
    if (!wnBytes) {
        console.warn(`[decodeWatchNonce] no WatchNonce (field 31)`);
        return null;
    }
    let nonce = null;
    let hmac = null;
    let i = 0;
    while (i < wnBytes.length) {
        const tag = readVarint(wnBytes, i);
        if (!tag)
            break;
        const fn = tag.value >> 3;
        const wt = tag.value & 0x07;
        i = tag.next;
        if (wt !== 2) {
            i = skipField(wnBytes, i - (tag.next - i) - 1);
            continue;
        }
        const len = readVarint(wnBytes, i);
        if (!len || i + len.value > wnBytes.length)
            break;
        i = len.next;
        const val = wnBytes.slice(i, i + len.value);
        i += len.value;
        if (fn === 1)
            nonce = val;
        else if (fn === 2)
            hmac = val;
    }
    if (nonce && hmac)
        return { nonce, hmac };
    console.warn(`[decodeWatchNonce] missing nonce or hmac`);
    return null;
}
// ── AuthDeviceInfo ──
export function encodeAuthDeviceInfo(apiLevel, phoneName, region) {
    const fields = [];
    // field 1: unknown1 = 0 (varint)
    fields.push(new Uint8Array([0x08, 0x00]));
    // field 2: phoneApiLevel (fixed32)
    const apiLevelBytes = new Uint8Array(4);
    new DataView(apiLevelBytes.buffer).setFloat32(0, apiLevel, true);
    const f2Tag = encodeTag(2, 5);
    fields.push(new Uint8Array([...f2Tag, ...apiLevelBytes]));
    // field 3: phoneName (string)
    const nameBytes = new TextEncoder().encode(phoneName);
    const f3Tag = encodeTag(3, 2);
    const namePrefix = new Uint8Array(f3Tag.length + 1 + nameBytes.length);
    namePrefix.set(f3Tag, 0);
    namePrefix[f3Tag.length] = nameBytes.length;
    namePrefix.set(nameBytes, f3Tag.length + 1);
    fields.push(namePrefix);
    // field 4: unknown3 = 224 (varint: 0xe0 0x01)
    fields.push(new Uint8Array([0x20, 0xe0, 0x01]));
    // field 5: region (string)
    const regionBytes = new TextEncoder().encode(region);
    const f5Tag = encodeTag(5, 2);
    const regionPrefix = new Uint8Array(f5Tag.length + 1 + regionBytes.length);
    regionPrefix.set(f5Tag, 0);
    regionPrefix[f5Tag.length] = regionBytes.length;
    regionPrefix.set(regionBytes, f5Tag.length + 1);
    fields.push(regionPrefix);
    const totalLen = fields.reduce((s, f) => s + f.length, 0);
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const f of fields) {
        out.set(f, off);
        off += f.length;
    }
    return out;
}
// ── AuthStep3 (CMD_AUTH=27) ──
export function encodeAuthStep3Payload(encryptedNonces, encryptedDeviceInfo) {
    // AuthStep3: field 1 = encryptedNonces(bytes), field 2 = encryptedDeviceInfo(bytes)
    const f1Tag = encodeTag(1, 2);
    const f2Tag = encodeTag(2, 2);
    const out = new Uint8Array(f1Tag.length + 1 + encryptedNonces.length + f2Tag.length + 1 + encryptedDeviceInfo.length);
    let off = 0;
    out.set(f1Tag, off);
    off += f1Tag.length;
    out[off++] = encryptedNonces.length;
    out.set(encryptedNonces, off);
    off += encryptedNonces.length;
    out.set(f2Tag, off);
    off += f2Tag.length;
    out[off++] = encryptedDeviceInfo.length;
    out.set(encryptedDeviceInfo, off);
    return out;
}
export function encodeCommandAuthStep3(authStep3) {
    // Auth field 32 = authStep3
    const f32Tag = encodeTag(32, 2);
    const authAs = new Uint8Array(f32Tag.length + 1 + authStep3.length);
    authAs.set(f32Tag, 0);
    authAs[f32Tag.length] = authStep3.length;
    authAs.set(authStep3, f32Tag.length + 1);
    // Command field 3 = auth
    const f3Tag = encodeTag(3, 2);
    const cmdAuth = new Uint8Array(f3Tag.length + 1 + authAs.length);
    cmdAuth.set(f3Tag, 0);
    cmdAuth[f3Tag.length] = authAs.length;
    cmdAuth.set(authAs, f3Tag.length + 1);
    // Command: type=1, subtype=27
    const tTag = encodeTag(1, 0);
    const sTag = encodeTag(2, 0);
    const out = new Uint8Array(tTag.length + 1 + sTag.length + 1 + cmdAuth.length);
    let off = 0;
    out.set(tTag, off);
    off += tTag.length;
    out[off++] = 1;
    out.set(sTag, off);
    off += sTag.length;
    out[off++] = 27;
    out.set(cmdAuth, off);
    return out;
}
export function decodeAuthResponse(payload) {
    const authBytes = findField(payload, 3);
    if (!authBytes) {
        if (payload.length >= 2 && payload[0] === 0x08)
            return { status: payload[1], success: payload[1] === 1 };
        return null;
    }
    let i = 0;
    while (i < authBytes.length) {
        const tag = readVarint(authBytes, i);
        if (!tag)
            break;
        const fn = tag.value >> 3;
        const wt = tag.value & 0x07;
        i = tag.next;
        if (fn === 1 && wt === 0) {
            const v = readVarint(authBytes, i);
            if (!v)
                return null;
            return { status: v.value, success: v.value === 1 };
        }
        i = skipField(authBytes, i);
    }
    return null;
}
