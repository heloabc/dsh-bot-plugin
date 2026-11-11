import assert from 'node:assert/strict'
import test from 'node:test'
import { railMarks } from './turn-marks.ts'

test('a user line and its turn are two ticks, and the turn stays one tick', () => {
  const marks = railMarks([
    { id: 'u1', kind: 'user' },
    { id: 'think', kind: 'think', turn: 3 },
    { id: 'tool', kind: 'tool', turn: 3 },
    { id: 'answer', kind: 'assistant', turn: 3 },
    { id: 'u2', kind: 'user', turn: 4 },
  ])
  assert.deepEqual(
    marks.map(mark => mark.id),
    ['u1', 'turn:3', 'u2'],
  )
})

test('an assistant turn with no user line still gets a tick', () => {
  const marks = railMarks([{ id: 'answer', kind: 'assistant', turn: 1 }])
  assert.deepEqual(
    marks.map(mark => mark.id),
    ['turn:1'],
  )
})
