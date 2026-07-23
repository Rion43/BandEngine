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
// ── Low-level protobuf helpers ──
function skipField(data, i) {
    if (i >= data.length)
        return i;
    const tag = data[i];
    const wireType = tag & 0x07;
    i++;
    switch (wireType) {
        case 0: // varint
            while (i < data.length && data[i - 1] & 0x80)
                i++;
            return i;
        case 1: // fixed64
            return i + 8;
        case 2: // length-delimited
            if (i >= data.length)
                return data.length;
            let len = 0;
            let shift = 0;
            while (i < data.length) {
                const b = data[i++];
                len |= (b & 0x7f) << shift;
                shift += 7;
                if (!(b & 0x80))
                    break;
            }
            return i + len;
        case 5: // fixed32
            return i + 4;
        default:
            return data.length;
    }
}
function findField(data, fieldNum) {
    let i = 0;
    while (i < data.length) {
        const tag = data[i];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        i++;
        if (fn === fieldNum && wt === 2) {
            // length-delimited — read length
            let len = 0;
            let shift = 0;
            while (i < data.length) {
                const b = data[i++];
                len |= (b & 0x7f) << shift;
                shift += 7;
                if (!(b & 0x80))
                    break;
            }
            if (i + len > data.length)
                return null;
            return data.slice(i, i + len);
        }
        // skip this field
        if (wt === 0) {
            while (i < data.length && (data[i - 1] & 0x80))
                i++;
        }
        else if (wt === 1) {
            i += 8;
        }
        else if (wt === 5) {
            i += 4;
        }
        else if (wt === 2) {
            let len = 0;
            let shift = 0;
            while (i < data.length) {
                const b = data[i++];
                len |= (b & 0x7f) << shift;
                shift += 7;
                if (!(b & 0x80))
                    break;
            }
            i += len;
        }
        else {
            return null;
        }
    }
    return null;
}
// ── PhoneNonce (CMD_NONCE=26) ──
export function encodeCommandPhoneNonce(nonce) {
    // Command{type=1, subtype=26, auth{phoneNonce{nonce}}}
    // PhoneNonce field 1 = nonce (bytes) -> tag 0x0a
    const pnInner = new Uint8Array(2 + nonce.length);
    pnInner[0] = 0x0a;
    pnInner[1] = nonce.length;
    pnInner.set(nonce, 2);
    // Auth field 30 = phoneNonce -> tag 0xf2
    const authField = new Uint8Array(2 + pnInner.length);
    authField[0] = 0xf2; // (30<<3)|2 = 242 = 0xf2
    authField[1] = pnInner.length;
    authField.set(pnInner, 2);
    // Command field 3 = auth (length-delimited) -> tag 0x1a
    const cmdAuth = new Uint8Array(2 + authField.length);
    cmdAuth[0] = 0x1a;
    cmdAuth[1] = authField.length;
    cmdAuth.set(authField, 2);
    // Command wrapper: type=1, subtype=26
    const out = new Uint8Array(4 + cmdAuth.length);
    out[0] = 0x08; // field 1 type=varint
    out[1] = 1; // COMMAND_TYPE = 1
    out[2] = 0x10; // field 2 subtype=varint
    out[3] = 26; // CMD_NONCE = 26
    out.set(cmdAuth, 4);
    return out;
}
/**
 * Decode WatchNonce from a Command protobuf response.
 * Walks: Command.field3(Auth).field31(WatchNonce){nonce, hmac}
 */
export function decodeWatchNonce(payload) {
    // Step 1: Extract Auth (field 3) from Command
    const authBytes = findField(payload, 3);
    if (!authBytes) {
        console.warn(`[decodeWatchNonce] no Auth (field 3) in Command`);
        return null;
    }
    // Step 2: Extract WatchNonce (field 31) from Auth
    const wnBytes = findField(authBytes, 31);
    if (!wnBytes) {
        console.warn(`[decodeWatchNonce] no WatchNonce (field 31) in Auth`);
        return null;
    }
    // Step 3: Extract nonce(f1) and hmac(f2) from WatchNonce
    let nonce = null;
    let hmac = null;
    let i = 0;
    while (i < wnBytes.length) {
        const tag = wnBytes[i];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        i++;
        if (wt !== 2) {
            i = skipField(wnBytes, i - 1);
            continue;
        }
        let len = 0;
        let shift = 0;
        while (i < wnBytes.length) {
            const b = wnBytes[i++];
            len |= (b & 0x7f) << shift;
            shift += 7;
            if (!(b & 0x80))
                break;
        }
        if (i + len > wnBytes.length)
            break;
        const val = wnBytes.slice(i, i + len);
        i += len;
        if (fn === 1)
            nonce = val;
        else if (fn === 2)
            hmac = val;
    }
    if (nonce && hmac)
        return { nonce, hmac };
    console.warn(`[decodeWatchNonce] missing nonce or hmac in WatchNonce`);
    return null;
}
// ── AuthDeviceInfo ──
export function encodeAuthDeviceInfo(apiLevel, phoneName, region) {
    const fields = [];
    // field 1: unknown1 = 0 (varint)
    fields.push(new Uint8Array([0x08, 0x00]));
    // field 2: phoneApiLevel (fixed32 = wire type 5)
    // Gadgetbridge stores SDK_INT as float in proto, wire type fixed32
    const apiLevelBytes = new Uint8Array(4);
    new DataView(apiLevelBytes.buffer).setFloat32(0, apiLevel, true);
    fields.push(new Uint8Array([0x15, ...apiLevelBytes]));
    // field 3: phoneName (string, length-delimited)
    const nameBytes = new TextEncoder().encode(phoneName);
    const nameLen = nameBytes.length;
    if (nameLen <= 0x7f) {
        fields.push(new Uint8Array([0x1a, nameLen, ...nameBytes]));
    }
    else {
        const lenBuf = new Uint8Array(2);
        lenBuf[0] = nameLen | 0x80;
        lenBuf[1] = nameLen >> 7;
        fields.push(new Uint8Array([0x1a, ...lenBuf, ...nameBytes]));
    }
    // field 4: unknown3 = 224 (varint)
    fields.push(new Uint8Array([0x20, 0xe0, 0x01]));
    // field 5: region (string, 2-letter uppercase)
    const regionBytes = new TextEncoder().encode(region);
    fields.push(new Uint8Array([0x2a, regionBytes.length, ...regionBytes]));
    const totalLen = fields.reduce((sum, f) => sum + f.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const f of fields) {
        out.set(f, offset);
        offset += f.length;
    }
    return out;
}
// ── AuthStep3 (CMD_AUTH=27) ──
export function encodeCommandAuthStep3(authStep3) {
    // AuthStep3 wrapping:
    // Command{type=1, subtype=27, auth{authStep3{f1=encNonces, f2=encDeviceInfo}}}
    // AuthStep3 field 1 = encryptedNonces (bytes) -> tag 0x0a
    // AuthStep3 field 2 = encryptedDeviceInfo (bytes) -> tag 0x12
    // But authStep3 is already encoded by caller as [0x0a, len, nonces, 0x12, len, info]
    // Auth field 32 = authStep3 -> tag (32<<3)|2 = 258 varint = 0x82 0x02
    const authAs = new Uint8Array(3 + authStep3.length);
    authAs[0] = 0x82; // field 32, wire type 2
    authAs[1] = 0x02;
    authAs[2] = authStep3.length;
    authAs.set(authStep3, 3);
    // Command field 3 = auth
    const cmdAuth = new Uint8Array(2 + authAs.length);
    cmdAuth[0] = 0x1a;
    cmdAuth[1] = authAs.length;
    cmdAuth.set(authAs, 2);
    // Command: type=1, subtype=27
    const out = new Uint8Array(4 + cmdAuth.length);
    out[0] = 0x08;
    out[1] = 1;
    out[2] = 0x10;
    out[3] = 27;
    out.set(cmdAuth, 4);
    return out;
}
export function encodeAuthStep3Payload(encryptedNonces, encryptedDeviceInfo) {
    // AuthStep3 protobuf: field 1 = encryptedNonces(bytes), field 2 = encryptedDeviceInfo(bytes)
    const out = new Uint8Array(4 + encryptedNonces.length + encryptedDeviceInfo.length);
    out[0] = 0x0a;
    out[1] = encryptedNonces.length;
    out.set(encryptedNonces, 2);
    const off = 2 + encryptedNonces.length;
    out[off] = 0x12;
    out[off + 1] = encryptedDeviceInfo.length;
    out.set(encryptedDeviceInfo, off + 2);
    return out;
}
export function decodeAuthResponse(payload) {
    // Extract Auth (field 3) from Command
    const authBytes = findField(payload, 3);
    if (!authBytes) {
        // Maybe it's just a flat status byte
        if (payload.length >= 2 && payload[0] === 0x08) {
            const status = payload[1];
            return { status, success: status === 1 };
        }
        return null;
    }
    // Find status (field 1, varint) in Auth
    let i = 0;
    while (i < authBytes.length) {
        const tag = authBytes[i];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        i++;
        if (fn === 1 && wt === 0) {
            // varint
            let val = 0;
            let shift = 0;
            while (i < authBytes.length) {
                const b = authBytes[i++];
                val |= (b & 0x7f) << shift;
                shift += 7;
                if (!(b & 0x80))
                    break;
            }
            return { status: val, success: val === 1 };
        }
        i = skipField(authBytes, i - 1);
    }
    return null;
}
