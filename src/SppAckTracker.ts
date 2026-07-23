// SppAckTracker — ACK tracking for SPPv2 protocol
// Each sent DATA packet expects an ACK with matching sequence number.
// Tracks timeouts and logs ACK receive events.

export interface PendingAck {
  sequenceNumber: number;
  channel: string;
  sentAt: number;
  timeoutMs: number;
  timedOut: boolean;
  resolved: boolean;
}

export class SppAckTracker {
  private pending: Map<number, PendingAck> = new Map();
  private _onTimeout?: (seq: number) => void;

  set onTimeout(handler: ((seq: number) => void) | undefined) {
    this._onTimeout = handler;
  }

  /**
   * Register a pending ACK for a sent packet.
   */
  register(sequenceNumber: number, channel: string, timeoutMs = 5000): void {
    this.pending.set(sequenceNumber, {
      sequenceNumber,
      channel,
      sentAt: Date.now(),
      timeoutMs,
      timedOut: false,
      resolved: false,
    });
    console.log(`[SppAckTracker] registered seq=${sequenceNumber} channel=${channel} timeout=${timeoutMs}ms`);
  }

  /**
   * Resolve an ACK receipt.
   */
  resolve(sequenceNumber: number): PendingAck | null {
    const entry = this.pending.get(sequenceNumber);
    if (!entry) {
      console.warn(`[SppAckTracker] received ACK for seq=${sequenceNumber} but no pending entry`);
      return null;
    }
    entry.resolved = true;
    const elapsed = Date.now() - entry.sentAt;
    console.log(`[SppAckTracker] ACK received for seq=${sequenceNumber} channel=${entry.channel} (${elapsed}ms)`);
    this.pending.delete(sequenceNumber);
    return entry;
  }

  /**
   * Check all pending ACKs for timeouts.
   * Returns timed-out entries.
   */
  checkTimeouts(): PendingAck[] {
    const now = Date.now();
    const timedOut: PendingAck[] = [];
    for (const [seq, entry] of this.pending) {
      if (!entry.resolved && !entry.timedOut && (now - entry.sentAt) > entry.timeoutMs) {
        entry.timedOut = true;
        timedOut.push(entry);
        console.warn(`[SppAckTracker] TIMEOUT seq=${seq} channel=${entry.channel} after ${entry.timeoutMs}ms`);
        this._onTimeout?.(seq);
        this.pending.delete(seq);
      }
    }
    return timedOut;
  }

  /**
   * Get number of pending ACKs.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Reset all state.
   */
  reset(): void {
    const count = this.pending.size;
    this.pending.clear();
    console.log(`[SppAckTracker] reset (cleared ${count} pending ACKs)`);
  }
}
