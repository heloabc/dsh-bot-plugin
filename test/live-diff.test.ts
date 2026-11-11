import assert from 'node:assert/strict'
import test from 'node:test'
import { applyValue, diffValue } from '../src/live-diff.ts'

function roundTrip(prev: any, next: any) {
  const patch = diffValue(prev, next)
  assert.ok(patch)
  assert.equal(diffValue(applyValue(prev, patch), next), null)
  return patch
}

test('an unchanged document has no patch', () => {
  const doc = { sessions: [{ sessionId: 'a', running: false }] }
  assert.equal(diffValue(doc, { sessions: [{ sessionId: 'a', running: false }] }), null)
})

test('a timestamp change does not repeat the session list', () => {
  const prev = {
    sessions: {
      result: {
        value: {
          items: [
            { sessionId: 'a', projections: { values: { title: 'alpha' } } },
            { sessionId: 'b', projections: { values: { title: 'beta' } } },
          ],
        },
      },
    },
    usage: { summary: { fetched_at: 't0', daily: [{ date: '2026-11-10', usage_usd: 1 }] } },
  }
  const next = {
    sessions: {
      result: {
        value: {
          items: [
            { sessionId: 'a', projections: { values: { title: 'alpha' } } },
            { sessionId: 'b', projections: { values: { title: 'beta-edited' } } },
          ],
        },
      },
    },
    usage: { summary: { fetched_at: 't1', daily: [{ date: '2026-11-10', usage_usd: 1 }] } },
  }
  const patch = roundTrip(prev, next)
  const text = JSON.stringify(patch)
  assert.equal(text.includes('alpha'), false)
  assert.equal(text.includes('2026-11-10'), false)
  assert.equal(text.includes('beta-edited'), true)
  assert.equal(text.includes('t1'), true)
})

test('a removed session and a reordered list survive the patch', () => {
  const prev = [
    { sessionId: 'a', n: 1 },
    { sessionId: 'b', n: 2 },
    { sessionId: 'c', n: 3 },
  ]
  const next = [
    { sessionId: 'c', n: 3 },
    { sessionId: 'a', n: 1 },
  ]
  const patch = roundTrip(prev, next)
  if (patch.t !== 'l') throw new Error(`expected a list patch, got ${patch.t}`)
  assert.deepEqual(patch.d, ['b'])
  assert.deepEqual(patch.order, ['c', 'a'])
  assert.equal(JSON.stringify(patch).includes('"n":2'), false)
})

test('one ticket result does not repeat the other event text', () => {
  const prev = {
    cards: {
      owner: [
        {
          summary: 'KEEP-SUMMARY',
          ticket: { id: 't1', status: 'ready' },
          events: [
            { event_id: 'e1', text: 'OLD-RESULT' },
            { event_id: 'e2', text: 'KEEP-PROGRESS' },
          ],
        },
      ],
    },
  }
  const next = {
    cards: {
      owner: [
        {
          summary: 'KEEP-SUMMARY',
          ticket: { id: 't1', status: 'delivered' },
          events: [
            { event_id: 'e1', text: 'NEW-RESULT' },
            { event_id: 'e2', text: 'KEEP-PROGRESS' },
          ],
        },
      ],
    },
  }
  const patch = roundTrip(prev, next)
  const text = JSON.stringify(patch)
  assert.equal(text.includes('NEW-RESULT'), true)
  assert.equal(text.includes('delivered'), true)
  assert.equal(text.includes('KEEP-PROGRESS'), false)
  assert.equal(text.includes('KEEP-SUMMARY'), false)
  assert.equal(text.includes('OLD-RESULT'), false)
})
