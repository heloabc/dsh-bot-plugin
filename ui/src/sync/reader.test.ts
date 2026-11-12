import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createMemoryCheckpoint } from './checkpoint.ts'
import { createEventLogReader } from './reader.ts'
import type { BoundedTransport, LiveTransport, TransportOutcome, TransportSink } from './transport.ts'
import type { LogEvent } from './types.ts'

function ev(seq: number): LogEvent {
  return { type: 'user/message', seq, time: seq, data: { id: `m${seq}` } }
}

function followFrom(firstSeq: number, cursor: number, tail: LogEvent[] = []): LiveTransport {
  return {
    kind: 'ws-follow',
    async open(_req, sink, signal) {
      sink.opened({ firstSeq, cursor, hasMore: firstSeq > 0 })
      sink.head(cursor)
      const records = Array.from({ length: Math.max(0, cursor - firstSeq + 1) }, (_, i) => ev(firstSeq + i))
      if (records.length) sink.events(records)
      for (const event of tail) sink.events([event])
      await wait(5, signal).catch(() => {})
      return { ok: false, retryable: true, code: 'FOLLOW_CLOSED' }
    },
  }
}

function pageTransport(events: LogEvent[], hits: number[] = []): BoundedTransport {
  return {
    kind: 'official-page',
    async fetch(req, sink) {
      hits.push(1)
      const batch = events.filter(event => event.seq > req.afterSeq && event.seq <= req.throughSeq)
      if (batch.length) sink.events(batch, { throughSeq: req.throughSeq })
      return { ok: true, throughSeq: req.throughSeq }
    },
  }
}

function failingEnhance(code: string, statusHits?: number[]): BoundedTransport {
  return {
    kind: 'cdc-snapshot',
    async fetch() {
      statusHits?.push(1)
      return { ok: false, retryable: false, code }
    },
  }
}

test('enhancement off fills the gap with the official page and stays off error', async () => {
  const history = Array.from({ length: 8 }, (_, seq) => ev(seq))
  const pageHits: number[] = []
  const received: number[] = []
  const phases: string[] = []
  const reader = createEventLogReader({
    follow: followFrom(6, 7),
    page: pageTransport(history, pageHits),
    checkpoint: createMemoryCheckpoint(),
    wait: yieldWait,
    raf: cb => {
      cb()
      return 1
    },
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    sub.onStatus(status => phases.push(status.phase))
    const ready = await sub.ready
    assert.equal(ready.ok, true)
    if (ready.ok) assert.equal(ready.caughtUpTo >= 6, true)
    assert.ok(pageHits.length >= 1)
    assert.ok(received.includes(0) && received.includes(7))
    assert.ok(!phases.includes('error'))
    assert.notEqual(sub.status.phase, 'error')
  } finally {
    sub.close()
  }
})

test('a mid-sync 404 from CDC falls back to official page and does not error the subscription', async () => {
  // Gap must exceed RANGE_MAX_EVENTS so the reader chooses CDC over range/page.
  const head = 2010
  const history = Array.from({ length: head + 1 }, (_, seq) => ev(seq))
  const pageHits: number[] = []
  const cdcHits: number[] = []
  const received: number[] = []
  const reader = createEventLogReader({
    follow: followFrom(head, head),
    page: pageTransport(history, pageHits),
    cdc: failingEnhance('ENHANCE_UNAVAILABLE', cdcHits),
    range: failingEnhance('ENHANCE_UNAVAILABLE'),
    checkpoint: createMemoryCheckpoint(),
    probe: async () => true,
    wait: yieldWait,
    raf: cb => {
      cb()
      return 1
    },
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'auto' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    const ready = await withTimeout(sub.ready, 2000)
    assert.equal(ready.ok, true)
    assert.ok(cdcHits.length >= 1)
    assert.ok(pageHits.length >= 1)
    assert.ok(received.includes(0) && received.includes(head))
    assert.notEqual(sub.status.phase, 'error')
  } finally {
    sub.close()
  }
})

async function yieldWait(_ms: number, signal: AbortSignal) {
  await Promise.resolve()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}`)), ms)),
  ])
}
