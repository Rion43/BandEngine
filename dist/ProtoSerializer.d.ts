export declare class ProtoSerializer {
    private static root;
    static encodePacket(category: number, opcode: number, payload: Uint8Array): Uint8Array;
    static encodeHandshakeInit(phoneNonce: Uint8Array): Uint8Array;
    static decodeHandshakeResponse(data: Uint8Array): {
        bandNonce: Uint8Array;
        signature: Uint8Array;
    };
    static decodeHeartRateSample(data: Uint8Array): {
        timestamp: number;
        heartRate: number;
        confidence: number;
    };
    static decodeBatteryInfo(data: Uint8Array): {
        level: number;
        charging: boolean;
    };
    static decodeStepData(data: Uint8Array): {
        totalSteps: number;
        distance: number;
        calories: number;
    };
    static encodeNotification(app: string, title: string, body: string): Uint8Array;
}
