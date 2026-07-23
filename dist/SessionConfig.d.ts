export interface SessionConfigResponse {
    version?: number[];
    maxPacketSize?: number;
    txWin?: number;
    sendTimeout?: number;
}
export declare class SessionConfig {
    private onResponse?;
    setResponseHandler(handler: (response: SessionConfigResponse) => void): void;
    buildRequest(): Uint8Array;
    handleResponse(payload: Uint8Array): SessionConfigResponse | null;
    buildStopRequest(): Uint8Array;
}
