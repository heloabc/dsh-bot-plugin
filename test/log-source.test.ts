import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createLogSource, logHasMessage, spliceSeq, type LogEvent } from '../src/log/source.ts'

function event(seq: number, type = 'user/message', extra: Partial<LogEvent> = {}): LogEvent {
  return { type, seq, time: seq * 10, data: { id: `m${seq}` }, ...extra }
}

function mockCtx(
  logs: Record<string, LogEvent[]>,
  options: { missing?: Set<string>; resumed?: { count: number } } = {},
) {
  const missing = options.missing ?? new Set<string>()
  const disposed: string[] = []
  return {
    agents: {
      get() {
        return undefined
      },
      resume() {
        if (options.resumed) options.resumed.count += 1
      },
    },
    sessionQuery: {
      async observeSession(id: string) {
        if (missing.has(id)) {
          const error = new Error('missing')
          error.name = 'SessionNotFoundError'
          throw error
        }
        const events = logs[id] ?? []
        return {
          events,
          cursor: events.length === 0 ? -1 : events[events.length - 1]!.seq,
          inheritedEventCount: events.filter(item => item.seq < 0).length,
          header: { id },
          source: 'prepared',
          [Symbol.dispose]() {
            disposed.push(id)
          },
        }
      },
    },
    disposed,
  }
}

test('read is left-open right-closed and pins throughSeq to the observed head', async () => {
  const events = [event(0), event(1), event(2), event(3), event(4)]
  const source = createLogSource(mockCtx({ 'session-a': events }))
  assert.equal(await source.head('session-a'), 4)
  const page = await source.read('session-a', 1, 3)
  assert.deepEqual(
    page.events.map(item => item.seq),
    [2, 3],
  )
  assert.equal(page.throughSeq, 3)
  const clamped = await source.read('session-a', 2, 99)
  assert.deepEqual(
    clamped.events.map(item => item.seq),
    [3, 4],
  )
  assert.equal(clamped.throughSeq, 4)
  const empty = await source.read('session-a', 4)
  assert.deepEqual(empty.events, [])
  assert.equal(empty.throughSeq, 4)
  const all = await source.read('session-a', -1, -1)
  assert.deepEqual(all.events, [])
  assert.equal(all.throughSeq, -1)
})

test('a missing session is an empty log and does not resume an agent', async () => {
  const resumed = { count: 0 }
  const source = createLogSource(mockCtx({}, { missing: new Set(['gone']), resumed }))
  assert.equal(await source.head('gone'), -1)
  assert.deepEqual(await source.read('gone', -1), { events: [], throughSeq: -1 })
  assert.equal(resumed.count, 0)
})

test('observeSession leases are released after a read', async () => {
  const ctx = mockCtx({ 'session-a': [event(0), event(1)] })
  const source = createLogSource(ctx)
  await source.read('session-a', -1)
  assert.deepEqual(ctx.disposed, ['session-a'])
})

test('a forked session keeps the parent prefix seqs and continues after session/end-seed', async () => {
  const parent = [event(0, 'user/message'), event(1, 'assistant/message'), event(2, 'turn/end')]
  const child = [
    ...parent,
    event(3, 'session/end-seed', { data: { reason: 'fork' } }),
    event(4, 'user/message', { data: { id: 'child-1' } }),
    event(5, 'assistant/message', { data: { id: 'child-2' } }),
  ]
  const source = createLogSource(mockCtx({ parent, child }))
  const prefix = await source.read('child', -1, 2)
  assert.deepEqual(
    prefix.events.map(item => item.seq),
    [0, 1, 2],
  )
  assert.deepEqual(prefix.events, await source.read('parent', -1, 2).then(page => page.events))
  const tail = await source.read('child', 2)
  assert.equal(tail.events[0]?.type, 'session/end-seed')
  assert.deepEqual(
    tail.events.map(item => item.seq),
    [3, 4, 5],
  )
  const seqs = (await source.read('child', -1)).events.map(item => item.seq)
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5])
})

test('tail yields the durable prefix then live session/event rows in order', async () => {
  const logs: Record<string, LogEvent[]> = { live: [event(0), event(1)] }
  const listeners: Array<(session: unknown, event: LogEvent) => void> = []
  const ctx = {
    ...mockCtx(logs),
    on(_name: string, listener: (session: unknown, event: LogEvent) => void) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  const source = createLogSource(ctx)
  const ac = new AbortController()
  const received: number[] = []
  const running = (async () => {
    for await (const item of source.tail!('live', -1, ac.signal)) {
      received.push(item.seq)
      if (item.seq === 3) ac.abort()
    }
  })()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(received, [0, 1])
  listeners[0]?.({ id: 'live' }, event(2))
  listeners[0]?.({ id: 'other' }, event(9))
  listeners[0]?.({ id: 'live' }, event(3))
  await running
  assert.deepEqual(received, [0, 1, 2, 3])
})

test('logHasMessage and spliceSeq read agent/inbox/spliced from a log range', () => {
  const events = [event(0), event(1, 'agent/inbox/spliced', { data: { inserted: [{ id: 'msg-9' }] } })]
  assert.equal(logHasMessage(events, 'msg-9'), true)
  assert.equal(logHasMessage(events, 'missing'), false)
  assert.equal(spliceSeq(events, 'msg-9'), 1)
  assert.equal(spliceSeq(events, 'missing'), null)
})
