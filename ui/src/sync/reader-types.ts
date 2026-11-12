import type { LogEvent, SyncPhase, SyncResult, SyncStatus, LogBatch, SessionAddress } from './types.ts'

export type { SyncPhase, SyncResult, SyncStatus, LogBatch }

export interface Subscription {
  onBatch(listener: (batch: LogBatch) => void): () => void
  onEphemeral(listener: (frame: unknown) => void): () => void
  onStatus(listener: (status: SyncStatus) => void): () => void
  readonly status: SyncStatus
  readonly ready: Promise<SyncResult>
  close(): void
}

export interface EventLogReaderOptions {
  openingMessages?: number
  enhancement?: 'auto' | 'off'
  address?: SessionAddress
}

export interface EventLogReader {
  open(sessionId: string, options?: EventLogReaderOptions): Subscription
}

export type { LogEvent }
