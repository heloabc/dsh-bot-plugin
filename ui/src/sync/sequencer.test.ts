import { strict as assert } from 'node:assert'
import test from 'node:test'
import { Sequencer } from './sequencer.ts'
import { PENDING_MAX_EVENTS } from './constants.ts'
import type { LogEvent } from './types.ts'

function ev(seq: number, type = 'user/message'): LogEvent {
  return { type, seq, time: seq, data: { id: `m${seq}` } }
}

test('sequencer drops duplicates, delivers in order, and reports a gap', () => {
  const seq = new Sequencer(-1)
  const first = seq.push([ev(0), ev(2)])
  assert.deepEqual(
    first.delivered.map(item => item.seq),
    [0],
  )
  assert.equal(seq.appliedSeq, 0)
  assert.equal(first.gapTo, 2)
  const dup = seq.push([ev(0)])
  assert.deepEqual(dup.delivered, [])
  const rest = seq.push([ev(1)])
  assert.deepEqual(
    rest.delivered.map(item => item.seq),
    [1, 2],
  )
  assert.equal(seq.appliedSeq, 2)
  assert.equal(rest.gapTo, null)
})

test('out-of-order future events flush once the hole is filled', () => {
  const seq = new Sequencer(4)
  seq.push([ev(7), ev(6)])
  assert.equal(seq.appliedSeq, 4)
  assert.equal(seq.nextGap(), 6)
  const result = seq.push([ev(5)])
  assert.deepEqual(
    result.delivered.map(item => item.seq),
    [5, 6, 7],
  )
  assert.equal(seq.appliedSeq, 7)
})

test('a reconnect can replay already applied seqs safely', () => {
  const seq = new Sequencer(3)
  const result = seq.push([ev(1), ev(2), ev(3), ev(4)])
  assert.deepEqual(
    result.delivered.map(item => item.seq),
    [4],
  )
})

test('pending overflow drops the buffer and keeps appliedSeq so the gap can be reread', () => {
  const seq = new Sequencer(-1)
  const future = Array.from({ length: PENDING_MAX_EVENTS + 2 }, (_, i) => ev(i + 2))
  const result = seq.push(future)
  assert.equal(seq.appliedSeq, -1)
  assert.equal(seq.pending.size, 0)
  assert.ok(result.overflow)
  assert.equal(result.overflow?.afterSeq, -1)
})
