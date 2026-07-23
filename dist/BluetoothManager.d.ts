import { ParsedPacket, SppChannel } from './SppPacketV2.js';
import { SessionConfigResponse } from './SessionConfig.js';
export interface BluetoothTransport {
    write(data: Uint8Array): Promise<void>;
    onNotification(): Promise<Uint8Array>;
    disconnect(): void;
}
export declare class BluetoothManager implements BluetoothTransport {
    private server?;
    private writeChar?;
    private notifyChar?;
    private notificationQueue;
    private notificationResolve;
    private sppBuffer;
    private sppPacketHandler?;
    private sessionConfig;
    private sessionConfigSent;
    private sessionConfigConfirmed;
    private sessionConfigResponse;
    private _versionValidated;
    private _onVersionReady?;
    connect(): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    /** Raw notification bekle (bypass SPPv2 parser) */
    onNotification(): Promise<Uint8Array>;
    setPacketHandler(handler: (packet: ParsedPacket) => void): void;
    getSessionConfigConfirmed(): boolean;
    getSessionConfigResponse(): SessionConfigResponse | null;
    get versionValidated(): boolean;
    /** Version doğrulandığında tetiklenecek callback (auth başlatmak için). */
    onVersionReady(handler: () => void): void;
    /** SPPv2 DataPacket gönder */
    sendDataPacket(channel: SppChannel, payload: Uint8Array): Promise<void>;
    disconnect(): void;
    private sendSessionConfig;
    /** Gelen BLE notification → SPPv2 reassembly */
    private onBleData;
    private processSppBuffer;
    private onSppPacket;
}
