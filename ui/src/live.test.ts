import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleDocument, decodeChunk, hashList, mergeChunkBodies, missingHashes, retainChunks } from './live.ts'

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

test('ordered chunks assemble, a hole does not, and stale chunks are dropped', () => {
  const text = JSON.stringify({ ok: true, desk: { n: 1 } })
  const bytes = new TextEncoder().encode(text)
  const mid = Math.max(1, Math.floor(bytes.length / 2))
  const chunks = new Map<string, Uint8Array>([
    ['a', bytes.slice(0, mid)],
    ['b', bytes.slice(mid)],
  ])
  const body = assembleDocument(['a', 'b'], chunks, bytes.length)
  const doc =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { ok?: unknown; desk?: unknown })
      : null
  assert.equal(doc?.ok, true)
  assert.deepEqual(doc?.desk, { n: 1 })
  assert.equal(assembleDocument(['a', 'c'], chunks, bytes.length), null)
  assert.equal(assembleDocument(['a', 'b'], chunks, bytes.length + 1), null)
  mergeChunkBodies(chunks, { b: encode(bytes.slice(mid)), bad: '%%%' })
  assert.equal(decodeChunk(encode(bytes.slice(mid))).length, bytes.length - mid)
  retainChunks(chunks, ['a'])
  assert.deepEqual([...chunks.keys()], ['a'])
  assert.deepEqual(hashList(['a', 'b']), ['a', 'b'])
  assert.equal(hashList(['a', 1]), null)
  const listBytes = new TextEncoder().encode(JSON.stringify([{ seq: 1, type: 'user/message' }]))
  const list = assembleDocument(['log'], new Map([['log', listBytes]]), listBytes.length)
  assert.ok(Array.isArray(list))
  assert.equal(list[0]?.seq, 1)
  assert.deepEqual(missingHashes(['a', 'b', 'a', ''], new Set(['a'])), ['b'])
})
