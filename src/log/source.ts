/**
 * Production-layer adapter over the official session log.
 * It does not serialize, chunk, or know about browsers.
 */
import type { HostContext } from '../host.ts'

export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

export interface LogSource {
  /** Inclusive log end; an empty log is -1. */
  head(sessionId: string): Promise<number>
  /** (afterSeq, throughSeq], ascending. Omitting throughSeq pins to the head at read time. */
  read(sessionId: string, afterSeq: number, throughSeq?: number): Promise<{ events: LogEvent[]; throughSeq: number }>
  /** In-process tail for server consumers. */
  tail?(sessionId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<LogEvent>
}

type Observation = {
  readonly events?: readonly unknown[]
  readonly cursor?: number
  readonly header?: { id?: string }
  readonly source?: string
  readonly inheritedEventCount?: number
  readonly revision?: unknown
  [Symbol.dispose]?: () => void
}

type SessionQuery = {
  observeSession(
    sessionId: string,
    options?: { projectionMode?: 'all' | 'none'; signal?: AbortSignal },
  ): Promise<Observation>
}

export function createLogSource(ctx: HostContext): LogSource {
  const source: LogSource = {
    async head(sessionId) {
      const cut = await observe(ctx, sessionId)
      return cut.throughSeq
    },
    async read(sessionId, afterSeq, throughSeq) {
      const cut = await observe(ctx, sessionId)
      const end = throughSeq == null ? cut.throughSeq : Math.min(throughSeq, cut.throughSeq)
      const events = cut.events.filter(event => event.seq > afterSeq && event.seq <= end)
      return { events, throughSeq: end }
    },
    async *tail(sessionId, afterSeq, signal) {
      yield* tailEvents(ctx, source, sessionId, afterSeq, signal)
    },
  }
  return source
}

async function observe(ctx: HostContext, sessionId: string, signal?: AbortSignal) {
  const query = sessionQueryOf(ctx)
  let observation: Observation | undefined
  try {
    observation = await query.observeSession(sessionId, {
      projectionMode: 'none',
      ...(signal ? { signal } : {}),
    })
    const events = Array.isArray(observation.events)
      ? observation.events.map(asLogEvent).filter((event): event is LogEvent => event != null)
      : []
    events.sort((left, right) => left.seq - right.seq)
    const throughSeq = typeof observation.cursor === 'number' ? observation.cursor : lastSeq(events)
    return { events, throughSeq }
  } catch (error) {
    if (isMissingSession(error)) return { events: [] as LogEvent[], throughSeq: -1 }
    throw error
  } finally {
    release(observation)
  }
}

function sessionQueryOf(ctx: HostContext): SessionQuery {
  const found = (ctx.sessionQuery ?? ctx.get?.('sessionQuery')) as SessionQuery | undefined
  if (found?.observeSession == null) throw new Error('sessionQuery is not available')
  return found
}

function asLogEvent(value: unknown): LogEvent | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null
  const time = typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : 0
  const event: LogEvent = {
    type: record.type,
    seq: record.seq,
    time,
    data: record.data,
  }
  return {
    ...event,
    ...(record.surfaceOp !== undefined ? { surfaceOp: record.surfaceOp } : {}),
    ...(record.sourceEventSeqs !== undefined ? { sourceEventSeqs: record.sourceEventSeqs } : {}),
  }
}

function lastSeq(events: readonly LogEvent[]) {
  return events.length === 0 ? -1 : events[events.length - 1]!.seq
}

function isMissingSession(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return (
    name === 'SessionPersistenceNotFoundError' ||
    name === 'SessionNotFoundError' ||
    code.includes('NOT_FOUND') ||
    code.includes('MISSING_SESSION')
  )
}

function release(observation: Observation | undefined) {
  try {
    observation?.[Symbol.dispose]?.()
  } catch {
    /* already released */
  }
}

function sessionIdOf(session: unknown) {
  if (!session || typeof session !== 'object') return ''
  const record = session as { id?: unknown; header?: { id?: unknown; sessionId?: unknown }; sessionId?: unknown }
  const id = record.id ?? record.sessionId ?? record.header?.id ?? record.header?.sessionId
  return typeof id === 'string' ? id : ''
}

async function* tailEvents(
  ctx: HostContext,
  source: LogSource,
  sessionId: string,
  afterSeq: number,
  signal: AbortSignal,
): AsyncGenerator<LogEvent> {
  const pending: LogEvent[] = []
  let notify: (() => void) | null = null
  const onEvent = (session: unknown, event: unknown) => {
    if (sessionIdOf(session) !== sessionId) return
    const row = asLogEvent(event)
    if (!row) return
    pending.push(row)
    notify?.()
  }
  const off = ctx.on?.('session/event', onEvent, { global: true })
  const wait = () =>
    new Promise<void>(resolve => {
      if (signal.aborted) {
        resolve()
        return
      }
      notify = resolve
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  try {
    const { events, throughSeq } = await source.read(sessionId, afterSeq)
    let cursor = throughSeq
    for (const event of events) {
      if (signal.aborted) return
      yield event
    }
    const replay = pending.filter(event => event.seq > cursor).sort((left, right) => left.seq - right.seq)
    pending.length = 0
    pending.push(...replay)
    while (!signal.aborted) {
      const index = pending.findIndex(event => event.seq === cursor + 1)
      if (index >= 0) {
        const event = pending.splice(index, 1)[0]
        if (!event) continue
        cursor = event.seq
        yield event
        continue
      }
      await wait()
    }
  } finally {
    if (typeof off === 'function') off()
  }
}

export function logHasMessage(events: readonly LogEvent[], messageId: string) {
  return events.some(
    event =>
      (event.type === 'agent/inbox/spliced' && insertedIds(event).includes(messageId)) ||
      (event.type === 'user/message' && messageIdOf(event) === messageId),
  )
}

export function spliceSeq(events: readonly LogEvent[], messageId: string) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'agent/inbox/spliced' && insertedIds(event).includes(messageId)) return event.seq
  }
  return null
}

function insertedIds(event: LogEvent) {
  const inserted =
    event.data && typeof event.data === 'object'
      ? (event.data as { inserted?: Array<{ id?: string }> }).inserted
      : undefined
  if (!Array.isArray(inserted)) return [] as string[]
  return inserted.map(message => message?.id).filter((id): id is string => typeof id === 'string')
}

function messageIdOf(event: LogEvent) {
  if (!event.data || typeof event.data !== 'object') return ''
  const data = event.data as { id?: string; message?: { id?: string } }
  return data.id ?? data.message?.id ?? ''
}
