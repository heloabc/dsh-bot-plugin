import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleChunks } from '../src/cdc.ts'
import {
  canonicalBytes,
  createSessionSnapshots,
  eventLogBytes,
  eventsBefore,
  eventsWindow,
  followTailStart,
} from '../src/live-snapshot.ts'
import { openPageLive } from '../src/work-http.ts'

function filler(seed: number, length: number) {
  let state = seed || 1
  let out = ''
  for (let i = 0; i < length; i++) {
    state = Math.imul(state, 1664525) + 1013904223
    out += String.fromCharCode(32 + ((state >>> 16) % 95))
  }
  return out
}

function events(tail: string) {
  const rows = []
  for (let seq = 1; seq <= 12; seq++) {
    rows.push({
      type: 'user/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { text: filler(seq, 5000) },
    })
  }
  if (tail) rows.push({ type: 'assistant/message', seq: 13, time: 1_700_000_000_013, data: { text: tail } })
  return rows
}

test('a session manifest lists hashes and the chunk route returns only the ones asked for', () => {
  const snapshots = createSessionSnapshots()
  const first = events('')
  const plan = snapshots.publish('sess', first)
  const listed = snapshots.manifest('sess')
  assert.equal(listed.ok, true)
  assert.equal(Object.hasOwn(listed, 'chunks'), false)
  assert.equal(listed.count, first.length)
  assert.deepEqual(listed.hashes, plan.hashes)
  assert.ok(plan.hashes.length > 2)
  const last = plan.hashes[plan.hashes.length - 1]
  const taken = snapshots.take('sess', [last, last])
  assert.deepEqual(Object.keys(taken!.chunks), [last])
  const built = assembleChunks(plan.hashes, plan.chunks)
  assert.equal(built!.toString('utf8'), eventLogBytes(first).toString('utf8'))
  assert.equal(canonicalBytes(first).toString('utf8'), built!.toString('utf8'))
  assert.equal(snapshots.take('sess', ['missing']), null)
  assert.equal(snapshots.take('other', [last]), null)
})

test('the follow opening page stays out of the chunked prefix', () => {
  const log = [
    { type: 'turn/start', seq: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 11, surfaceOp: 'append', data: { text: 'kept' } },
    { type: 'assistant/message', seq: 12, surfaceOp: 'append', data: { text: 'TAIL-MARKER' } },
  ]
  const prefix = eventsBefore(log, 12)
  assert.deepEqual(
    prefix.map(event => event.seq),
    [10, 11],
  )
  assert.equal(eventLogBytes(prefix).toString('utf8').includes('TAIL-MARKER'), false)
  assert.deepEqual(eventsBefore(log, 0), [])
  assert.deepEqual(
    eventsBefore(log, 99).map(event => event.seq),
    [10, 11, 12],
  )
  const snapshots = createSessionSnapshots()
  const plan = snapshots.publish('sess', prefix)
  assert.equal(plan.totalSize, eventLogBytes(prefix).length)
  const built = assembleChunks(plan.hashes, plan.chunks)
  assert.equal(built!.toString('utf8').includes('TAIL-MARKER'), false)
})

test('four follow messages leave the older log for CDC', () => {
  const log = []
  for (let seq = 0; seq < 12; seq += 1) {
    log.push({
      type: seq % 2 === 0 ? 'user/message' : 'assistant/message',
      seq,
      surfaceOp: 'append',
      data: { text: `m${seq}` },
    })
  }
  const cut = followTailStart(log, 4)
  assert.equal(cut, 8)
  assert.deepEqual(
    eventsBefore(log, cut).map(event => event.seq),
    [0, 1, 2, 3, 4, 5, 6, 7],
  )
  assert.deepEqual(
    eventsWindow(log, cut, cut + 2).map(event => event.seq),
    [8, 9],
  )
  assert.equal(eventLogBytes(eventsBefore(log, cut)).toString('utf8').includes('m8'), false)
})

test('appending one event keeps the earlier chunk hashes', () => {
  const snapshots = createSessionSnapshots()
  const first = snapshots.publish('sess', events(''))
  const second = snapshots.publish('sess', events('tail'))
  assert.equal(second.hashes[0], first.hashes[0])
  assert.notEqual(second.epoch, first.epoch)
  assert.equal(second.hashes.includes(first.hashes[0]), true)
  const shared = first.hashes.filter(hash => second.hashes.includes(hash))
  assert.ok(shared.length >= 1)
})

test('page live sends changed desk and work as one snapshot, not CDC chunks', async () => {
  const marker = 'DESK-MARKER-9f3a'
  let stamp = '1'
  const work = { signals: { 'bot-a': ['ready'] }, cards: {} }
  const desk = { sessions: { previews: { a: marker } } }
  const chunks: any[] = []
  let close = () => {}
  let ended = false
  const pending = openPageLive(
    {
      socket: { setTimeout() {} },
      on(event: any, fn: any) {
        if (event === 'close') close = fn
      },
    },
    {
      get writableEnded() {
        return ended
      },
      writeHead() {},
      write(chunk: any) {
        chunks.push(String(chunk))
        return true
      },
      end() {
        ended = true
      },
      on() {},
    },
    {
      workStamp: () => stamp,
      workBoard: () => work,
      loadDesk: async () => desk,
      deskIntervalMs: 60_000,
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  const frames = chunks.filter(chunk => chunk.startsWith('event: snapshot'))
  assert.ok(frames.length >= 2)
  const deskFrame = frames.find(chunk => chunk.includes(marker))
  const workFrame = frames.find(chunk => chunk.includes('"work"'))
  assert.ok(deskFrame)
  assert.ok(workFrame)
  assert.ok(chunks.indexOf(deskFrame) < chunks.indexOf(workFrame))
  assert.equal(deskFrame.includes('"work"'), false)
  assert.equal(
    chunks.some(chunk => chunk.startsWith('event: delta')),
    false,
  )
  stamp = '1'
  close()
  await pending
})

test('a later live frame carries only the fields that changed', async () => {
  let stamp = '1'
  const board = {
    signals: { 'bot-a': ['ready'] },
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
  const chunks: any[] = []
  let close = () => {}
  let ended = false
  const pending = openPageLive(
    {
      socket: { setTimeout() {} },
      on(event: any, fn: any) {
        if (event === 'close') close = fn
      },
    },
    {
      get writableEnded() {
        return ended
      },
      writeHead() {},
      write(chunk: any) {
        chunks.push(String(chunk))
        return true
      },
      end() {
        ended = true
      },
      on() {},
    },
    {
      workStamp: () => stamp,
      workBoard: () => board,
      loadDesk: async () => ({ sessions: { previews: { a: 'desk-stays' } } }),
      deskIntervalMs: 60_000,
      intervalMs: 20,
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  stamp = '2'
  board.cards.owner[0].ticket.status = 'delivered'
  board.cards.owner[0].events[0].text = 'NEW-RESULT'
  await new Promise(resolve => setTimeout(resolve, 80))
  const deltas = chunks.filter(chunk => chunk.startsWith('event: delta'))
  assert.ok(deltas.length >= 1)
  const text = deltas.join('\n')
  assert.equal(text.includes('NEW-RESULT'), true)
  assert.equal(text.includes('delivered'), true)
  assert.equal(text.includes('KEEP-PROGRESS'), false)
  assert.equal(text.includes('KEEP-SUMMARY'), false)
  assert.equal(text.includes('desk-stays'), false)
  close()
  await pending
})
