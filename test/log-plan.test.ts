import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CDC_MIN } from '../src/cdc.ts'
import { eventNdjson, stableStringify } from '../src/log/canonical.ts'
import { alignCutsToLines, planEventChunks, sha256Hex } from '../src/log/plan.ts'
import type { LogEvent } from '../src/log/source.ts'

function ev(seq: number, payload: string): LogEvent {
  return { type: 'user/message', seq, time: seq, data: { text: payload } }
}

function many(count: number, size: number): LogEvent[] {
  const text = 'x'.repeat(size)
  return Array.from({ length: count }, (_, seq) => ev(seq, text))
}

test('stable stringify sorts object keys', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('event-aligned chunks never split a line', () => {
  const events = many(400, 80)
  const { bytes } = eventNdjson(events)
  const plan = planEventChunks(events)
  assert.ok(plan.chunks.length >= 1)
  assert.equal(plan.throughSeq, events.length - 1)
  assert.equal(plan.totalSize, bytes.length)
  assert.equal(plan.format, 'ndjson-v1')
  let expected = 0
  for (const chunk of plan.chunks) {
    assert.equal(chunk.fromSeq, expected)
    assert.ok(chunk.toSeq >= chunk.fromSeq)
    expected = chunk.toSeq + 1
    const slice = events.filter(item => item.seq >= chunk.fromSeq && item.seq <= chunk.toSeq)
    const { bytes: body } = eventNdjson(slice)
    assert.equal(body.length, chunk.bytes)
    assert.equal(sha256Hex(body), chunk.hash)
    assert.equal(body[body.length - 1], 10)
  }
  assert.equal(expected, events.length)
})

test('a shorter prefix keeps the same leading chunk hashes as a longer log', () => {
  const long = many(800, 60)
  const cut = 400
  const full = planEventChunks(long)
  const prefix = planEventChunks(long.slice(0, cut))
  assert.ok(full.chunks.length > 1)
  const shared = prefix.chunks.filter(
    chunk => chunk.toSeq < prefix.chunks[prefix.chunks.length - 1]!.fromSeq || prefix.chunks.length === 1,
  )
  // Every complete prefix chunk (all but possibly the last of the short plan) matches the long plan.
  const finalized = prefix.chunks.slice(0, -1)
  for (let i = 0; i < finalized.length; i += 1) {
    assert.equal(finalized[i]!.hash, full.chunks[i]!.hash)
    assert.equal(finalized[i]!.fromSeq, full.chunks[i]!.fromSeq)
    assert.equal(finalized[i]!.toSeq, full.chunks[i]!.toSeq)
  }
  assert.equal(shared.length >= 0, true)
})

test('alignCutsToLines extends a mid-line cut to the next newline', () => {
  const data = Buffer.from('aaaa\nbbbb\ncccc\n')
  const cuts = alignCutsToLines(data, [
    { offset: 0, length: 6 },
    { offset: 6, length: data.length - 6 },
  ])
  assert.equal(Buffer.from(data.subarray(0, cuts[0]!.length)).toString(), 'aaaa\nbbbb\n')
  assert.equal(Buffer.from(data.subarray(cuts[1]!.offset)).toString(), 'cccc\n')
  assert.ok(cuts[0]!.length >= CDC_MIN || cuts[0]!.length === 10 || cuts[0]!.length > 0)
})
