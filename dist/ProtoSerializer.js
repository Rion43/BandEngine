// ProtoSerializer — protobuf encode/decode helpers
// Uses protobufjs for the shared message format
// Field mapping from reverse-engineered Mi Fitness app:
//   f40546q → category (uint32)
//   f40543c → opcode   (uint32)
import protobuf from 'protobufjs';
/**
 * Lazy-loaded root for the inner packet protobuf.
 * Schema matches the obfuscated e8.a class.
 */
let _MessageRoot = null;
function getRoot() {
    if (!_MessageRoot) {
        _MessageRoot = protobuf.Root.fromJSON({
            nested: {
                Packet: {
                    fields: {
                        category: {
                            type: 'uint32',
                            id: 1,
                            options: { '(f40546q)': true },
                        },
                        opcode: {
                            type: 'uint32',
                            id: 2,
                            options: { '(f40543c)': true },
                        },
                        payload: { type: 'bytes', id: 3 },
                    },
                },
                HandshakeInit: {
                    fields: {
                        phoneNonce: { type: 'bytes', id: 1 },
                    },
                },
                HandshakeResponse: {
                    fields: {
                        bandNonce: { type: 'bytes', id: 1 },
                        signature: { type: 'bytes', id: 2 },
                    },
                },
                HeartRateSample: {
                    fields: {
                        timestamp: { type: 'uint32', id: 1 },
                        heartRate: { type: 'float', id: 2 },
                        confidence: { type: 'float', id: 3 },
                    },
                },
                BatteryInfo: {
                    fields: {
                        level: { type: 'uint32', id: 1 },
                        charging: { type: 'bool', id: 2 },
                    },
                },
                StepData: {
                    fields: {
                        totalSteps: { type: 'uint32', id: 1 },
                        distance: { type: 'float', id: 2 },
                        calories: { type: 'float', id: 3 },
                    },
                },
                Notification: {
                    fields: {
                        app: { type: 'string', id: 1 },
                        title: { type: 'string', id: 2 },
                        body: { type: 'string', id: 3 },
                        icon: { type: 'string', id: 4 },
                    },
                },
            },
        });
    }
    return _MessageRoot;
}
export class ProtoSerializer {
    // ── Inner packet ──
    static encodePacket(category, opcode, payload) {
        const Packet = this.root.lookupType('Packet');
        const msg = Packet.create({ category, opcode, payload });
        return Packet.encode(msg).finish();
    }
    // ── Handshake ──
    static encodeHandshakeInit(phoneNonce) {
        const Init = this.root.lookupType('HandshakeInit');
        return Init.encode({ phoneNonce }).finish();
    }
    static decodeHandshakeResponse(data) {
        const Resp = this.root.lookupType('HandshakeResponse');
        const dec = Resp.decode(data);
        return {
            bandNonce: dec.bandNonce,
            signature: dec.signature,
        };
    }
    // ── HeartRate ──
    static decodeHeartRateSample(data) {
        const Sample = this.root.lookupType('HeartRateSample');
        const dec = Sample.decode(data);
        return {
            timestamp: dec.timestamp >>> 0,
            heartRate: dec.heartRate,
            confidence: dec.confidence,
        };
    }
    // ── Battery ──
    static decodeBatteryInfo(data) {
        const Bat = this.root.lookupType('BatteryInfo');
        const dec = Bat.decode(data);
        return {
            level: dec.level >>> 0,
            charging: !!dec.charging,
        };
    }
    // ── Steps ──
    static decodeStepData(data) {
        const Step = this.root.lookupType('StepData');
        const dec = Step.decode(data);
        return {
            totalSteps: dec.totalSteps >>> 0,
            distance: dec.distance,
            calories: dec.calories,
        };
    }
    // ── Notification ──
    static encodeNotification(app, title, body) {
        const Notif = this.root.lookupType('Notification');
        return Notif.encode({ app, title, body }).finish();
    }
}
ProtoSerializer.root = getRoot();
