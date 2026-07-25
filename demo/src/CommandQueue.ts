// CommandQueue — ACK-based write queue (Gadgetbridge txWin flow control)
//
// Band'de txWin=3: max 3 unacked packet. 4. paket = disconnect.
// Her DATA paketi notification kanalindan ACK bekler.
// ACK gelince sıradaki paket gider. 3000ms timeout.
//
// Gadgetbridge BtLEQueue + WriteAction latch birebir portu.
// Android'de onCharacteristicWrite callback, BE'de notification ACK.

import { log } from './logger.js';
import { SppPacketV2, SppPacketType } from '../../src/SppPacketV2.js';

export class CommandQueue {
  private pendingAcks = new Map<number, { seq: number; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private _onDisconnect?: () => void;

  set onDisconnect(handler: (() => void) | undefined) {
    this._onDisconnect = handler;
  }

  /** Handle incoming notification bytes — parse ACK, resolve pending. */
  feedNotification(data: Uint8Array): void {
    // SPPv2 header: preamble(2) | typeFlags(1) | seq(1) | len(2) | crc(2)
    if (data.length < 4) return;
    const packetType = data[2] & 0x0f;
    const seq = data[3];

    if (packetType === SppPacketType.ACK) {
      // ACK paketi: type=1, seq=expected sequence
      const pending = this.pendingAcks.get(seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(seq);
        log('ack', `[Queue] ACK seq=${seq} (${this.pendingAcks.size} pending)`);
        pending.resolve(true);
      } else {
        log('ack', `[Queue] ACK seq=${seq} (unexpected)`);
      }
      return;
    }

    // DATA paketi: icinde ACK olabilir mi? Hayir, sadece ACK type=1.
    // Ama SPPv2 ACK ayri bir packet type, ayri seq numarasi ile gelir.
  }

  /** Send a DATA packet and wait for ACK. Throws on timeout/disconnect. */
  async enqueue(writeChar: BluetoothRemoteGATTCharacteristic | null, sppPacket: Uint8Array, timeoutMs = 3000): Promise<void> {
    // txWin kontrol: 3'ten fazla pending ACK varsa bekle
    while (this.pendingAcks.size >= 3) {
      log('warn', `[Queue] txWin full (${this.pendingAcks.size} pending), waiting...`);
      await new Promise(r => setTimeout(r, 100));
    }

    if (!writeChar) throw new Error('no writeChar');

    const seq = sppPacket[3];
    log('sent', `[Queue] DATA seq=${seq} (${this.pendingAcks.size} pending)`);

    // Promise: ACK gelene kadar bekle
    const ackPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(seq);
        log('error', `[Queue] TIMEOUT seq=${seq} (${timeoutMs}ms)`);
        resolve(false);
      }, timeoutMs);

      this.pendingAcks.set(seq, { seq, resolve, timer });
    });

    // Write
    const ab = sppPacket.slice().buffer as ArrayBuffer;
    try {
      if (writeChar.properties.writeWithoutResponse) {
        await writeChar.writeValueWithoutResponse(ab);
      } else {
        await writeChar.writeValue(ab);
      }
    } catch (e: any) {
      // Write failed: cleanup pending
      const pending = this.pendingAcks.get(seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(seq);
      }
      log('error', `[Queue] write failed seq=${seq}: ${e.message}`);
      this._onDisconnect?.();
      throw e;
    }

    // ACK bekle
    const ok = await ackPromise;
    if (!ok) {
      this._onDisconnect?.();
      throw new Error(`ACK timeout — seq: ${seq}`);
    }
  }

  /** Reset all pending ACKs (on disconnect). */
  reset(): void {
    for (const [seq, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingAcks.clear();
    log('info', '[Queue] reset all pending ACKs');
  }

  get pendingCount(): number {
    return this.pendingAcks.size;
  }
}
