import assert from 'node:assert/strict'
import test from 'node:test'
import { planChunks } from '../../src/cdc.ts'
import { eventLogBytes } from '../../src/live-snapshot.ts'
import { readJsonStream } from './api.ts'
import { cachedEvent, memoryCache } from './cache.ts'
import { loadSessionSnapshot } from './session-snapshot.ts'

function filler(seed: number, length: number) {
  let state = seed || 1
  let out = ''
  for (let i = 0; i < length; i++) {
    state = Math.imul(state, 1664525) + 1013904223
    out += String.fromCharCode(32 + ((state >>> 16) % 95))
  }
  return out
}

function seqOf(value: unknown): unknown {
  return value !== null && typeof value === 'object' && 'seq' in value ? value.seq : undefined
}

function events() {
  return Array.from({ length: 12 }, (_, index) => ({
    type: 'user/message',
    seq: index + 1,
    time: 1_700_000_000_000 + index,
    data: { text: filler(index + 3, 5000) },
  }))
}

test('session open fetches only the chunk hashes missing from the cache', async () => {
  const log = events()
  const plan = planChunks(eventLogBytes(log))
  const cache = memoryCache()
  const kept = plan.hashes[0]
  const keptBody = plan.chunks.get(kept)
  assert.ok(keptBody)
  await cache.putChunks(new Map([[kept, keptBody]]))
  const asked: string[] = []
  const get = async (path: string) => {
    asked.push(path)
    if (path.startsWith('/snapshot?')) {
      return { status: 200, body: { ok: true, epoch: plan.epoch, totalSize: plan.totalSize, hashes: plan.hashes } }
    }
    const hashes = [...path.matchAll(/hash=([^&]+)/g)].map(match => decodeURIComponent(match[1]))
    const chunks: Record<string, string> = {}
    for (const hash of hashes) {
      const body = plan.chunks.get(hash)
      if (!body) continue
      chunks[hash] = Buffer.from(body).toString('base64')
    }
    return { status: 200, body: { ok: true, chunks } }
  }
  const progress: Array<{ loaded: number; total: number }> = []
  const loaded = await loadSessionSnapshot('sess', cache, get, step => progress.push({ ...step }))
  assert.ok(Array.isArray(loaded.events))
  assert.equal(loaded.events.length, log.length)
  assert.equal(seqOf(loaded.events?.[0]), 1)
  assert.ok(progress.length >= 2)
  assert.ok(progress[0].loaded > 0)
  assert.ok(progress[0].loaded < progress[0].total)
  assert.equal(progress.at(-1)?.loaded, progress.at(-1)?.total)
  const chunkCalls = asked.filter(path => path.startsWith('/snapshot/chunks'))
  assert.ok(chunkCalls.length > 0)
  assert.equal(
    chunkCalls.some(path => path.includes(`hash=${encodeURIComponent(kept)}`)),
    false,
  )
  const stored = await cache.readEvents('sess')
  assert.equal(stored.length, log.length)
  assert.equal(stored[0]?.seq, 1)
})

test('a follow cut asks only for the prefix and skips chunk calls when that prefix is empty', async () => {
  const asked: string[] = []
  const get = async (path: string) => {
    asked.push(path)
    return { status: 200, body: { ok: true, epoch: '', totalSize: 0, hashes: [] } }
  }
  const loaded = await loadSessionSnapshot('sess', memoryCache(), get, undefined, 0, 40)
  assert.deepEqual(loaded.events, [])
  assert.equal(loaded.beforeSeq, 40)
  assert.deepEqual(asked, ['/snapshot?sessionId=sess&beforeSeq=40'])
})

test('events already cached for the prefix are not fetched again when the chunk hashes change', async () => {
  const log = events()
  const prefix = log.slice(0, 8)
  const tail = log[8]
  const plan = planChunks(eventLogBytes(prefix))
  const cache = memoryCache()
  const rows = [...prefix, tail].flatMap(event => {
    const row = cachedEvent('sess', event)
    return row ? [row] : []
  })
  await cache.putEvents('sess', rows)
  const asked: string[] = []
  const progress: Array<{ loaded: number; total: number }> = []
  const get = async (path: string) => {
    asked.push(path)
    return {
      status: 200,
      body: {
        ok: true,
        epoch: 'next',
        totalSize: plan.totalSize,
        hashes: plan.hashes.map(hash => `moved-${hash}`),
        beforeSeq: tail.seq,
        count: prefix.length,
      },
    }
  }
  const loaded = await loadSessionSnapshot('sess', cache, get, step => progress.push({ ...step }), 0, undefined, 4)
  assert.equal(loaded.beforeSeq, tail.seq)
  assert.equal(loaded.events?.length, prefix.length)
  assert.equal(seqOf(loaded.events?.[0]), prefix[0]?.seq)
  assert.equal(
    loaded.events?.some(event => seqOf(event) === tail.seq),
    false,
  )
  assert.deepEqual(asked, ['/snapshot?sessionId=sess&tailMessages=4'])
  assert.deepEqual(progress, [])
})

test('a short event cache still fetches the missing prefix chunks', async () => {
  const log = events()
  const plan = planChunks(eventLogBytes(log))
  const cache = memoryCache()
  const row = cachedEvent('sess', log[0])
  assert.ok(row)
  await cache.putEvents('sess', [row])
  const asked: string[] = []
  const get = async (path: string) => {
    asked.push(path)
    if (path.startsWith('/snapshot?')) {
      return {
        status: 200,
        body: { ok: true, epoch: plan.epoch, totalSize: plan.totalSize, hashes: plan.hashes, count: log.length },
      }
    }
    const hashes = [...path.matchAll(/hash=([^&]+)/g)].map(match => decodeURIComponent(match[1]))
    const chunks: Record<string, string> = {}
    for (const hash of hashes) {
      const body = plan.chunks.get(hash)
      if (!body) continue
      chunks[hash] = Buffer.from(body).toString('base64')
    }
    return { status: 200, body: { ok: true, chunks } }
  }
  const loaded = await loadSessionSnapshot('sess', cache, get)
  assert.equal(loaded.events?.length, log.length)
  assert.ok(asked.some(path => path.startsWith('/snapshot/chunks')))
})

test('a tail budget asks the server to cut the follow page off the chunk list', async () => {
  const asked: string[] = []
  const get = async (path: string) => {
    asked.push(path)
    return { status: 200, body: { ok: true, epoch: 'e', totalSize: 0, hashes: [], beforeSeq: 270 } }
  }
  const loaded = await loadSessionSnapshot('sess', memoryCache(), get, undefined, 0, undefined, 4)
  assert.deepEqual(loaded.events, [])
  assert.equal(loaded.beforeSeq, 270)
  assert.deepEqual(asked, ['/snapshot?sessionId=sess&tailMessages=4'])
})

test('a stale chunk plan is fetched again once', async () => {
  const log = events()
  const plan = planChunks(eventLogBytes(log))
  const cache = memoryCache()
  let stale = true
  const get = async (path: string) => {
    if (path.startsWith('/snapshot?')) {
      return { status: 200, body: { ok: true, epoch: plan.epoch, totalSize: plan.totalSize, hashes: plan.hashes } }
    }
    if (stale) {
      stale = false
      return { status: 409, body: { ok: false, code: 'STALE' } }
    }
    const hashes = [...path.matchAll(/hash=([^&]+)/g)].map(match => decodeURIComponent(match[1]))
    const chunks: Record<string, string> = {}
    for (const hash of hashes) {
      const body = plan.chunks.get(hash)
      if (body) chunks[hash] = Buffer.from(body).toString('base64')
    }
    return { status: 200, body: { ok: true, chunks } }
  }
  const loaded = await loadSessionSnapshot('sess', cache, get)
  assert.equal(loaded.events?.length, log.length)
  assert.equal(stale, false)
})

test('bytes arriving inside one chunk response move the progress before the response ends', async () => {
  const log = events()
  const plan = planChunks(eventLogBytes(log))
  const cache = memoryCache()
  const steps: number[] = []
  const get = async (path: string, onBytes?: (received: number, total: number | null) => void) => {
    if (path.startsWith('/snapshot?')) {
      return { status: 200, body: { ok: true, epoch: plan.epoch, totalSize: plan.totalSize, hashes: plan.hashes } }
    }
    const hashes = [...path.matchAll(/hash=([^&]+)/g)].map(match => decodeURIComponent(match[1]))
    onBytes?.(Math.max(1, Math.floor(plan.totalSize / 10)), plan.totalSize)
    const chunks: Record<string, string> = {}
    for (const hash of hashes) {
      const body = plan.chunks.get(hash)
      if (body) chunks[hash] = Buffer.from(body).toString('base64')
    }
    return { status: 200, body: { ok: true, chunks } }
  }
  const loaded = await loadSessionSnapshot('sess', cache, get, step => steps.push(step.loaded))
  assert.equal(loaded.events?.length, log.length)
  const last = steps.at(-1) ?? 0
  assert.equal(last, plan.totalSize)
  assert.ok(steps.some((value, index) => index > 0 && value > steps[0] && value < last))
})

test('a json body reports each streamed piece', async () => {
  const text = JSON.stringify({ ok: true, n: 1 })
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 4))
      controller.enqueue(bytes.slice(4))
      controller.close()
    },
  })
  const response = new Response(stream, { headers: { 'content-length': String(bytes.byteLength) } })
  const seen: number[] = []
  const body = await readJsonStream(response, received => seen.push(received))
  assert.equal(
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'ok' in body ? body.ok : false,
    true,
  )
  assert.deepEqual(seen, [4, bytes.byteLength])
})

test('stream deltas are not cache rows, and a later seq replaces nothing already stored under another seq', async () => {
  assert.equal(cachedEvent('sess', { type: 'assistant/live-chunk', seq: 4, data: { text: 'x' } }), null)
  assert.equal(cachedEvent('sess', { type: 'assistant-stream', seq: 4 }), null)
  const row = cachedEvent('sess', { type: 'assistant/message', seq: 4, data: { text: 'done' } })
  assert.ok(row)
  const cache = memoryCache()
  await cache.putEvents('sess', [row])
  await cache.putEvents('sess', [row])
  const stored = await cache.readEvents('sess')
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.seq, 4)
})
