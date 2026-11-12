import type { LogEvent } from './types.ts'
import { PENDING_MAX_BYTES, PENDING_MAX_EVENTS } from './constants.ts'

export interface SequencerOverflow {
  afterSeq: number
  dropped: number
}

export class Sequencer {
  appliedSeq: number
  headSeq: number | null = null
  readonly pending = new Map<number, LogEvent>()
  private pendingBytes = 0
  constructor(appliedSeq = -1) {
    this.appliedSeq = appliedSeq
  }

  setHead(seq: number) {
    if (this.headSeq == null || seq > this.headSeq) this.headSeq = seq
  }

  push(events: readonly LogEvent[]): {
    delivered: LogEvent[]
    gapTo: number | null
    overflow: SequencerOverflow | null
  } {
    const delivered: LogEvent[] = []
    for (const event of events) {
      if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) continue
      if (event.seq <= this.appliedSeq) continue
      if (event.seq === this.appliedSeq + 1) {
        delivered.push(event)
        this.appliedSeq = event.seq
        this.flushPending(delivered)
        continue
      }
      if (!this.pending.has(event.seq)) {
        this.pending.set(event.seq, event)
        this.pendingBytes += estimateBytes(event)
      }
    }
    let overflow: SequencerOverflow | null = null
    if (this.pending.size > PENDING_MAX_EVENTS || this.pendingBytes > PENDING_MAX_BYTES) {
      overflow = { afterSeq: this.appliedSeq, dropped: this.pending.size }
      this.pending.clear()
      this.pendingBytes = 0
    }
    const gapTo = this.nextGap()
    return { delivered, gapTo, overflow }
  }

  private flushPending(delivered: LogEvent[]) {
    while (this.pending.has(this.appliedSeq + 1)) {
      const event = this.pending.get(this.appliedSeq + 1)
      this.pending.delete(this.appliedSeq + 1)
      if (!event) break
      this.pendingBytes = Math.max(0, this.pendingBytes - estimateBytes(event))
      delivered.push(event)
      this.appliedSeq = event.seq
    }
  }

  nextGap(): number | null {
    if (this.pending.size === 0) return null
    let min = Number.POSITIVE_INFINITY
    for (const seq of this.pending.keys()) if (seq < min) min = seq
    return Number.isFinite(min) ? min : null
  }
}

function estimateBytes(event: LogEvent) {
  return 64 + (typeof event.type === 'string' ? event.type.length : 0)
}
