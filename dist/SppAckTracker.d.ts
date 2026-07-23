export interface PendingAck {
    sequenceNumber: number;
    channel: string;
    sentAt: number;
    timeoutMs: number;
    timedOut: boolean;
    resolved: boolean;
}
export declare class SppAckTracker {
    private pending;
    private _onTimeout?;
    set onTimeout(handler: ((seq: number) => void) | undefined);
    /**
     * Register a pending ACK for a sent packet.
     */
    register(sequenceNumber: number, channel: string, timeoutMs?: number): void;
    /**
     * Resolve an ACK receipt.
     */
    resolve(sequenceNumber: number): PendingAck | null;
    /**
     * Check all pending ACKs for timeouts.
     * Returns timed-out entries.
     */
    checkTimeouts(): PendingAck[];
    /**
     * Get number of pending ACKs.
     */
    get pendingCount(): number;
    /**
     * Reset all state.
     */
    reset(): void;
}
