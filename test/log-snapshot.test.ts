import { strict as assert } from 'node:assert'
import test from 'node:test'
import { eventNdjson } from '../src/log/canonical.ts'
import { dispatchLogRequest } from '../src/log/routes.ts'
import { createLogSnapshotService } from '../src/log/snapshot-service.ts'
import { createLogSource, type LogEvent, type LogSource } from '../src/log/source.ts'

function ev(seq: number, text = `t${seq}`): LogEvent {
  return { type: 'user/message', seq, time: seq, data: { text } }
}

function memorySource(logs: Record<string, LogEvent[]>): LogSource {
  return createLogSource({
    sessionQuery: {
      async observeSession(id: string) {
        const events = logs[id] ?? []
        return {
          events,
          cursor: events.length === 0 ? -1 : events[events.length - 1]!.seq,
          [Symbol.dispose]() {},
        }
      },
    },
  })
}

function events(count: number, size = 64) {
  const text = 'n'.repeat(size)
  return Array.from({ length: count }, (_, seq) => ev(seq, text))
}

async function get(service: ReturnType<typeof createLogSnapshotService>, path: string, method = 'GET') {
  const response = await dispatchLogRequest(service, new Request(`http://127.0.0.1${path}`, { method }))
  assert.ok(response)
  return response!
}

test('manifest pins throughSeq and trims chunks after afterSeq', async () => {
  const log = events(120, 80)
  const service = createLogSnapshotService(memorySource({ s: log }))
  const res = await get(service, '/api/dsh-bot/log/manifest?sessionId=s&throughSeq=80')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    throughSeq: number
    totalSize: number
    chunks: Array<{ fromSeq: number; toSeq: number; hash: string }>
    format: string
  }
  assert.equal(body.throughSeq, 80)
  assert.equal(body.format, 'ndjson-v1')
  assert.ok(body.chunks.length >= 1)
  assert.ok(body.chunks.every(chunk => chunk.toSeq <= 80))
  const trimmed = (await (
    await get(service, '/api/dsh-bot/log/manifest?sessionId=s&throughSeq=80&afterSeq=40')
  ).json()) as {
    chunks: Array<{ toSeq: number }>
    totalSize: number
  }
  assert.ok(trimmed.chunks.every(chunk => chunk.toSeq > 40))
  assert.equal(trimmed.totalSize, body.totalSize ?? trimmed.totalSize)
})

test('chunk bytes match the seq range and reject a wrong hash', async () => {
  const log = events(80, 100)
  const service = createLogSnapshotService(memorySource({ s: log }))
  const manifest = (await (await get(service, '/api/dsh-bot/log/manifest?sessionId=s&throughSeq=79')).json()) as {
    chunks: Array<{ fromSeq: number; toSeq: number; hash: string; bytes: number }>
  }
  const chunk = manifest.chunks[0]!
  const ok = await get(
    service,
    `/api/dsh-bot/log/chunk?sessionId=s&fromSeq=${chunk.fromSeq}&toSeq=${chunk.toSeq}&hash=${chunk.hash}`,
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'private, immutable')
  const bytes = Buffer.from(await ok.arrayBuffer())
  assert.equal(bytes.length, chunk.bytes)
  const expected = eventNdjson(log.filter(item => item.seq >= chunk.fromSeq && item.seq <= chunk.toSeq)).bytes
  assert.deepEqual(bytes, expected)
  const bad = await get(
    service,
    `/api/dsh-bot/log/chunk?sessionId=s&fromSeq=${chunk.fromSeq}&toSeq=${chunk.toSeq}&hash=00`,
  )
  assert.equal(bad.status, 409)
})

test('range is left-open, right-closed, and paginated', async () => {
  const log = events(20, 8)
  const service = createLogSnapshotService(memorySource({ s: log }))
  const first = (await (
    await get(service, '/api/dsh-bot/log/range?sessionId=s&afterSeq=2&throughSeq=10&limit=3')
  ).json()) as {
    events: LogEvent[]
    throughSeq: number
    nextAfterSeq: number | null
  }
  assert.deepEqual(
    first.events.map(item => item.seq),
    [3, 4, 5],
  )
  assert.equal(first.throughSeq, 10)
  assert.equal(first.nextAfterSeq, 5)
  const last = (await (
    await get(service, `/api/dsh-bot/log/range?sessionId=s&afterSeq=${first.nextAfterSeq}&throughSeq=10&limit=10`)
  ).json()) as { events: LogEvent[]; nextAfterSeq: number | null }
  assert.deepEqual(
    last.events.map(item => item.seq),
    [6, 7, 8, 9, 10],
  )
  assert.equal(last.nextAfterSeq, null)
})

test('HEAD /log/range answers 200 without a sessionId so clients can probe the enhancement', async () => {
  const service = createLogSnapshotService(memorySource({}))
  const response = await get(service, '/api/dsh-bot/log/range', 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
})

test('throughSeq past the head is 409 and a missing sessionId is 400', async () => {
  const service = createLogSnapshotService(memorySource({ s: events(3) }))
  const stale = await get(service, '/api/dsh-bot/log/manifest?sessionId=s&throughSeq=99')
  assert.equal(stale.status, 409)
  const missing = await get(service, '/api/dsh-bot/log/manifest')
  assert.equal(missing.status, 400)
})

test('registerLogRoutes is a no-op when connection.fetch.register is missing', async () => {
  const { registerLogRoutes } = await import('../src/log/routes.ts')
  const service = createLogSnapshotService(memorySource({}))
  assert.equal(registerLogRoutes({} as any, service), false)
  let registered = 0
  const handle = {
    fetch: {
      register() {
        registered += 1
        return () => {}
      },
    },
  }
  const ctx = {
    effect(run: () => void) {
      run()
    },
    get(name: string) {
      return name === 'connection' ? handle : undefined
    },
  }
  assert.equal(registerLogRoutes(ctx as any, service), true)
  assert.equal(registered, 3)
})
