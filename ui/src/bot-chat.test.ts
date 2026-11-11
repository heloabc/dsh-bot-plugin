import assert from 'node:assert/strict'
import test from 'node:test'
import { botExchange, inboxSummary, mainSegments, outboundPeer } from './bot-chat.ts'
import type { Segment } from './types.ts'

const inbound = `[foundations:message]
id: mail-1
from: session-other
correlation: corr-1
causation:
hop: 1
This is an explicit message.
---
Got it, thanks.`

function user(id: string, text: string, seq: number): Segment {
  return { kind: 'user', id, text, seq }
}

function tool(id: string, name: string, args: unknown, seq: number): Segment {
  return {
    kind: 'tool',
    id,
    callId: id,
    name,
    args: JSON.stringify(args),
    result: '',
    error: false,
    running: false,
    seq,
  }
}

test('inbox mail stays in the main transcript and the latest line becomes the summary', () => {
  const segments = [
    user('u1', 'ask them for me', 1),
    tool('t1', 'foundations_send', { targetSessionId: 'session-other', text: 'are you there' }, 2),
    user('m1', inbound, 3),
    { kind: 'assistant', id: 'a1', text: 'they replied', streaming: false, seq: 4 } as Segment,
  ]
  const exchange = botExchange(segments)
  assert.deepEqual(
    exchange.map(item => item.kind),
    ['out', 'in'],
  )
  assert.deepEqual(
    mainSegments(segments).map(segment => segment.id),
    ['u1', 'm1', 'a1'],
  )
  const summary = inboxSummary(exchange, id => (id === 'session-other' ? 'Ernie' : ''))
  assert.equal(summary?.who, 'Ernie')
  assert.equal(summary?.preview, 'Got it, thanks.')
  assert.equal(summary?.count, 1)
})

test('a send stays in the main transcript until an inbox message arrives', () => {
  const segments = [
    user('u1', 'go say hello', 1),
    tool('t1', 'foundations_send', { targetSessionId: 'session-other', text: 'morning' }, 2),
  ]
  assert.deepEqual(
    mainSegments(segments).map(segment => segment.id),
    ['u1', 't1'],
  )
  assert.equal(
    inboxSummary(botExchange(segments), () => ''),
    null,
  )
})

test('a reply names the bot that sent the matching inbox message', () => {
  const exchange = botExchange([
    user('m1', inbound, 1),
    tool('t1', 'foundations_reply', { correlationId: 'corr-1', text: 'got it' }, 2),
  ])
  const sent = exchange.find(item => item.kind === 'out')
  assert.ok(sent && sent.kind === 'out')
  assert.equal(outboundPeer(sent, exchange), 'session-other')
})

test('a long inbox body is cut to one line', () => {
  const body = 'x'.repeat(80)
  const text = inbound.replace('Got it, thanks.', body)
  const summary = inboxSummary(botExchange([user('m1', text, 1)]), () => '')
  assert.equal(summary?.who, 'BOT')
  assert.equal(summary?.preview.length, 72)
  assert.ok(summary?.preview.endsWith('…'))
  assert.equal(summary?.preview.includes('\n'), false)
})
