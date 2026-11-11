import assert from 'node:assert/strict'
import test from 'node:test'
import { CDC_MAX, CDC_MIN, chunkBuffer, planChunks } from '../src/cdc.ts'

test('chunks a buffer and stays inside the FastCDC bounds', () => {
  const data = new Uint8Array(100 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = i % 256
  const chunks = chunkBuffer(data)
  assert.ok(chunks.length > 1)
  let total = 0
  for (const chunk of chunks) {
    assert.equal(chunk.offset, total)
    assert.ok(chunk.length >= CDC_MIN)
    assert.ok(chunk.length <= CDC_MAX)
    total += chunk.length
  }
  assert.equal(total, data.length)
})

test('a buffer under the minimum is one chunk', () => {
  const data = new Uint8Array(2048)
  const chunks = chunkBuffer(data)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].offset, 0)
  assert.equal(chunks[0].length, 2048)
})

test('the same bytes always cut at the same places', () => {
  const data = new Uint8Array(50 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.sin(i) * 256) & 255
  assert.deepEqual(chunkBuffer(data), chunkBuffer(data.slice()))
  assert.deepEqual(planChunks(data).hashes, planChunks(data.slice()).hashes)
})

test('inserting one byte keeps the chunk hashes outside that edit', () => {
  // A short repeating cycle never satisfies the gear mask, so every chunk hits the
  // maximum and an insert shifts them all. Mixed bytes are what a desk snapshot is.
  const data1 = new Uint8Array(200 * 1024)
  let state = 0x12345678
  for (let i = 0; i < data1.length; i++) {
    state = Math.imul(state, 1664525) + 1013904223
    data1[i] = (state >>> 16) & 255
  }
  const data2 = new Uint8Array(data1.length + 1)
  data2.set(data1.subarray(0, 50000), 0)
  data2[50000] = 0xaa
  data2.set(data1.subarray(50000), 50001)

  const plan1 = planChunks(data1)
  const plan2 = planChunks(data2)
  let shared = 0
  let prefix = 0
  const seen = new Set(plan2.hashes)
  let offset = 0
  for (let i = 0; i < plan1.hashes.length; i++) {
    const length = plan1.chunks.get(plan1.hashes[i])!.length
    if (offset + length <= 45000) {
      prefix += 1
      assert.equal(plan1.hashes[i], plan2.hashes[i])
    }
    if (offset > 60000 && seen.has(plan1.hashes[i])) shared += 1
    offset += length
  }
  assert.ok(prefix > 0)
  assert.ok(shared > 0)
})
