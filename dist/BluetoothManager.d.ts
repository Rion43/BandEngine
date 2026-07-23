import { ParsedPacket, SppChannel } from './SppPacketV2.js';
import { SessionConfigResponse } from './SessionConfig.js';
import { SppAuthProtocol } from './SppAuthProtocol.js';
import { SppAckTracker } from './SppAckTracker.js';
export interface BluetoothTransport {
    write(data: Uint8Array): Promise<void>;
    onNotification(): Promise<Uint8Array>;
    disconnect(): void;
}
export declare class BluetoothManager implements BluetoothTransport {
    private server?;
    private writeChar?;
    private notifyChar?;
    private notificationBuffer;
    private notificationResolve;
    private sppPacketBuffer;
    private sppPacketHandler?;
    private sessionConfig;
    private sessionConfigSent;
    private sessionConfigConfirmed;
    private sessionConfigResponse;
    private authProtocol;
    readonly ackTracker: SppAckTracker;
    private pendingAuthResolve;
    connect(): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    onNotification(): Promise<Uint8Array>;
    setPacketHandler(handler: (packet: ParsedPacket) => void): void;
    sendProtobufCommand(commandBytes: Uint8Array, channel?: SppChannel): Promise<void>;
    getSessionConfigConfirmed(): boolean;
    getSessionConfigResponse(): SessionConfigResponse | null;
    private waitForDataPayload;
    /** Full auth handshake: PhoneNonce → WatchNonce → AuthStep3 → result */
    authHandshake(authProtocol: SppAuthProtocol): Promise<boolean>;
    disconnect(): void;
    private sendSessionConfig;
    private handleIncomingData;
    private processSppBuffer;
    private handleParsedPacket;
    private findNextPreamble;
}
