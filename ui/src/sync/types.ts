export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'subagent'
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly mode: 'one-shot' | 'continuable' | 'unknown'
    }

export type SyncPhase = 'restoring' | 'syncing' | 'live' | 'stalled' | 'error' | 'closed'

export interface SyncProgress {
  appliedSeq: number
  headSeq: number | null
  lag: number | null
  fraction: number | null
}

export interface SyncStatus extends SyncProgress {
  phase: SyncPhase
  error?: { code: string; message: string; retrying: boolean }
}

export type SyncResult = { ok: true; caughtUpTo: number } | { ok: false; code: string; message: string }

export interface LogBatch {
  readonly events: readonly LogEvent[]
  readonly fromCache: boolean
}

export function sessionAddress(
  sessionId: string,
  source?: { parentSessionId?: string; mode?: 'one-shot' | 'continuable' | 'unknown' },
): SessionAddress {
  if (source?.parentSessionId) {
    return {
      kind: 'subagent',
      parentSessionId: source.parentSessionId,
      childSessionId: sessionId,
      mode: source.mode ?? 'unknown',
    }
  }
  return { kind: 'session', sessionId }
}
