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
let _MessageRoot: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
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
  private static root = getRoot();

  // ── Inner packet ──

  static encodePacket(
    category: number,
    opcode: number,
    payload: Uint8Array,
  ): Uint8Array {
    const Packet = this.root.lookupType('Packet');
    const msg = Packet.create({ category, opcode, payload });
    return Packet.encode(msg).finish() as Uint8Array;
  }

  // ── Handshake ──

  static encodeHandshakeInit(phoneNonce: Uint8Array): Uint8Array {
    const Init = this.root.lookupType('HandshakeInit');
    return Init.encode({ phoneNonce }).finish() as Uint8Array;
  }

  static decodeHandshakeResponse(data: Uint8Array): {
    bandNonce: Uint8Array;
    signature: Uint8Array;
  } {
    const Resp = this.root.lookupType('HandshakeResponse');
    const dec = Resp.decode(data) as any;

    return {
      bandNonce: dec.bandNonce as Uint8Array,
      signature: dec.signature as Uint8Array,
    };
  }

  // ── HeartRate ──

  static decodeHeartRateSample(data: Uint8Array): {
    timestamp: number;
    heartRate: number;
    confidence: number;
  } {
    const Sample = this.root.lookupType('HeartRateSample');
    const dec = Sample.decode(data) as any;
    return {
      timestamp: dec.timestamp >>> 0,
      heartRate: dec.heartRate as number,
      confidence: dec.confidence as number,
    };
  }

  // ── Battery ──

  static decodeBatteryInfo(data: Uint8Array): {
    level: number;
    charging: boolean;
  } {
    const Bat = this.root.lookupType('BatteryInfo');
    const dec = Bat.decode(data) as any;
    return {
      level: dec.level >>> 0,
      charging: !!dec.charging,
    };
  }

  // ── Steps ──

  static decodeStepData(data: Uint8Array): {
    totalSteps: number;
    distance: number;
    calories: number;
  } {
    const Step = this.root.lookupType('StepData');
    const dec = Step.decode(data) as any;
    return {
      totalSteps: dec.totalSteps >>> 0,
      distance: dec.distance as number,
      calories: dec.calories as number,
    };
  }

  // ── Notification ──

  static encodeNotification(app: string, title: string, body: string): Uint8Array {
    const Notif = this.root.lookupType('Notification');
    return Notif.encode({ app, title, body }).finish() as Uint8Array;
  }
}
