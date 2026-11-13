import type { LogEvent } from './types.ts'

export type TransportKind = 'ws-follow' | 'official-page' | 'cdc-snapshot' | 'plugin-range'

export interface TransportSink {
  events(batch: readonly LogEvent[], meta?: { throughSeq?: number }): void
  head(seq: number): void
  progress(p: { loaded: number; total: number | null; unit: 'bytes' | 'events' }): void
  ephemeral(frame: unknown): void
}

export type TransportOutcome =
  | { ok: true; throughSeq: number }
  | { ok: false; retryable: boolean; code: string; message?: string }

export interface BoundedTransport {
  readonly kind: 'official-page' | 'cdc-snapshot' | 'plugin-range'
  fetch(
    req: { sessionId: string; afterSeq: number; throughSeq: number },
    sink: TransportSink,
    signal: AbortSignal,
  ): Promise<TransportOutcome>
  estimate?(req: {
    sessionId: string
    afterSeq: number
    throughSeq: number
  }): Promise<{ events?: number; bytes?: number }>
}

export interface LiveTransport {
  readonly kind: 'ws-follow'
  open(
    req: { sessionId: string },
    sink: TransportSink & {
      opened(info: FollowOpenedInfo): void
    },
    signal: AbortSignal,
  ): Promise<TransportOutcome>
}

export interface FollowOpenedInfo {
  firstSeq: number
  cursor: number
  hasMore: boolean
  /** Cheap local liveness probe for the live channel (e.g. WebSocket readyState is OPEN). */
  alive?: () => boolean
}
