// Session Config Handler for Xiaomi Smart Band 9
// Handles SPPv2 SESSION_CONFIG packets (OPCODE_START_SESSION_REQUEST/RESPONSE)
import { SppPacketV2, SppPacketType, SessionConfigOpcode } from './SppPacketV2.js';
export class SessionConfig {
    setResponseHandler(handler) {
        this.onResponse = handler;
    }
    buildRequest() {
        console.log('[SessionConfig] build START_SESSION_REQUEST');
        return SppPacketV2.buildSessionConfigRequest();
    }
    handleResponse(payload) {
        console.log('[SessionConfig] raw response:', toHex(payload));
        if (payload.length < 1) {
            console.warn('[SessionConfig] empty response');
            return null;
        }
        const opcode = payload[0];
        console.log('[SessionConfig] opcode:', opcode);
        if (opcode !== SessionConfigOpcode.START_SESSION_RESPONSE) {
            console.warn('[SessionConfig] unexpected opcode:', opcode);
            return null;
        }
        const response = SppPacketV2.parseSessionConfigResponse(payload);
        if (!response)
            return null;
        console.log('[SessionConfig] parsed:', response);
        this.onResponse?.(response);
        return response;
    }
    buildStopRequest() {
        const payload = new Uint8Array([SessionConfigOpcode.STOP_SESSION_REQUEST]);
        return SppPacketV2.encode(SppPacketType.SESSION_CONFIG, SppPacketV2.getNextSequence(), payload);
    }
}
function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
