import { OPENING_MESSAGES } from './constants.ts'
import type { LiveTransport, TransportSink } from './transport.ts'
import { sessionAddress, type LogEvent, type SessionAddress } from './types.ts'

export type AddressOf = (sessionId: string) => SessionAddress

export function createWsFollowTransport(options: {
  addressOf?: AddressOf
  openingMessages?: number
  websocket?: (url: string) => WebSocket
  url?: string
}): LiveTransport {
  const addressOf = options.addressOf ?? (sessionId => sessionAddress(sessionId))
  const openingMessages = options.openingMessages ?? OPENING_MESSAGES
  return {
    kind: 'ws-follow',
    open(req, sink, signal) {
      return new Promise(resolve => {
        const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = typeof location !== 'undefined' ? location.host : '127.0.0.1'
        const url = options.url ?? `${proto}//${host}/api/remote.mux`
        const socket = (options.websocket ?? (target => new WebSocket(target)))(url)
        const streamId = `follow-${Math.random().toString(36).slice(2)}`
        let settled = false
        const finish = (
          outcome: { ok: true; throughSeq: number } | { ok: false; retryable: boolean; code: string; message?: string },
        ) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          try {
            socket.close()
          } catch {
            /* closed */
          }
          resolve(outcome)
        }
        const onAbort = () => finish({ ok: false, retryable: false, code: 'ABORTED' })
        signal.addEventListener('abort', onAbort)
        socket.addEventListener('open', () => {
          if (signal.aborted) return
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId,
              endpoint: 'session/follow',
              payload: {
                args: {
                  request: {
                    address: addressOf(req.sessionId),
                    maxMessages: openingMessages,
                    assistantStream: true,
                    activate: true,
                  },
                },
              },
            }),
          )
        })
        socket.addEventListener('message', event => {
          let frame: { type?: unknown; streamId?: unknown; value?: unknown; error?: { message?: string } }
          try {
            frame = JSON.parse(String(event.data)) as typeof frame
          } catch {
            return
          }
          if (frame.streamId !== streamId) return
          if (frame.type === 'error') {
            finish({ ok: false, retryable: true, code: 'FOLLOW_ERROR', message: frame.error?.message })
            return
          }
          if (frame.type === 'end') {
            finish({ ok: true, throughSeq: -1 })
            return
          }
          if (frame.type !== 'item') return
          handleItem(frame.value, sink)
        })
        socket.addEventListener('close', () => finish({ ok: false, retryable: true, code: 'FOLLOW_CLOSED' }))
        socket.addEventListener('error', () => finish({ ok: false, retryable: true, code: 'FOLLOW_ERROR' }))
      })
    },
  }
}

function handleItem(
  value: unknown,
  sink: TransportSink & { opened(info: { firstSeq: number; cursor: number; hasMore: boolean }): void },
) {
  const payload = payloadOf(value)
  if (!payload) return
  if (payload.type === 'snapshot') {
    const cursor = typeof payload.cursor === 'number' ? payload.cursor : -1
    const records = collectEvents(payload.records)
    const firstSeq = records.length > 0 ? Math.min(...records.map(event => event.seq)) : cursor + 1
    const hasMore = payload.hasMore === true
    sink.opened({ firstSeq, cursor, hasMore })
    sink.head(cursor)
    if (records.length) sink.events(records)
    sink.ephemeral(payload)
    return
  }
  if (payload.type === 'assistant-stream') {
    sink.ephemeral(payload)
    return
  }
  const events = collectEvents(payload)
  if (events.length) sink.events(events)
}

export function payloadOf(frame: unknown): Record<string, unknown> | null {
  if (!frame || typeof frame !== 'object') return null
  const record = frame as Record<string, unknown>
  if (
    typeof record.type === 'string' &&
    (record.type === 'snapshot' || record.type === 'assistant-stream' || record.type === 'event')
  ) {
    return record
  }
  const value = record.value
  if (value && typeof value === 'object' && !Array.isArray(value)) return payloadOf(value)
  return record
}

export function collectEvents(node: unknown): LogEvent[] {
  const out: LogEvent[] = []
  walk(node, out)
  return out.sort((left, right) => left.seq - right.seq)
}

function walk(node: unknown, out: LogEvent[]) {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return
  }
  if (typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (record.event && typeof record.event === 'object') {
    const event = asEvent(record.event)
    if (event) out.push(event)
    return
  }
  const event = asEvent(record)
  if (event) out.push(event)
  if (Array.isArray(record.records)) walk(record.records, out)
  if (Array.isArray(record.events)) walk(record.events, out)
}

function asEvent(value: unknown): LogEvent | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.seq !== 'number') return null
  return {
    type: record.type,
    seq: record.seq,
    time: typeof record.time === 'number' ? record.time : 0,
    data: record.data,
    ...(record.surfaceOp !== undefined ? { surfaceOp: record.surfaceOp } : {}),
    ...(record.sourceEventSeqs !== undefined ? { sourceEventSeqs: record.sourceEventSeqs } : {}),
  }
}
