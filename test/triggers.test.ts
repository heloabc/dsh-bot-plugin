import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { openStore } from '../src/store.ts'
import { createTriggers } from '../src/triggers.ts'
import { nextCron } from '../src/cron.ts'
import { field } from './narrow.ts'

test('cron uses Asia/Shanghai wall time', () => {
  const next = nextCron('0 9 * * *', Date.parse('2026-11-08T00:00:00.000Z'), 'Asia/Shanghai')
  assert.equal(next, '2026-11-08T01:00:00.000Z')
})

test('acl, native push, idempotency, hop, webhook, timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-triggers-'))
  const store = openStore(dir)
  const pushed: any[] = []
  const present = new Set()
  const triggers = createTriggers(store, {
    maxHop: 2,
    pid: 42,
    now: () => new Date('2026-11-08T00:00:00.000Z'),
    push: async (sessionId: any, messageId: any, text: any) => {
      pushed.push({ sessionId, messageId, text })
      present.add(messageId)
      return { ok: true, seq: pushed.length, ambiguous: false }
    },
    logHas: async (_sessionId: any, messageId: any) => present.has(messageId),
  })

  const stamp = new Date().toISOString()
  for (const id of ['session-a', 'session-b']) {
    store.db
      .prepare(`
      INSERT INTO session_bindings (
        session_id, kind, status, schema_version, fork_seeded, last_view_revision, compaction_epoch, created_at, updated_at
      ) VALUES (?, 'bot', 'active', 1, 0, 0, 0, ?, ?)
    `)
      .run(id, stamp, stamp)
  }

  const sent = field(
    await triggers.send('session-a', {
      targetSessionId: 'session-b',
      text: 'relay',
      idempotencyKey: 'm1',
      sessionId: 'session-forged',
    }),
    'deliveryId',
  )
  assert.equal(sent.status, 'accepted')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].sessionId, 'session-b')
  assert.match(pushed[0].text, /from: session-a/)
  assert.doesNotMatch(pushed[0].text, /session-forged/)
  assert.equal(pushed[0].text.split('\n---\n')[1], 'relay')
  const again = field(
    await triggers.send('session-a', {
      targetSessionId: 'session-b',
      text: 'relay',
      idempotencyKey: 'm1',
    }),
    'deliveryId',
  )
  assert.equal(again.deliveryId, sent.deliveryId)
  assert.equal(pushed.length, 1)

  assert.equal(triggers.deny('session-b', 'session-a').ok, true)
  const denied = field(
    await triggers.send('session-a', {
      targetSessionId: 'session-b',
      text: 'no',
      idempotencyKey: 'm-denied',
    }),
    'code',
  )
  assert.equal(denied.code, 'FORBIDDEN')
  assert.equal(pushed.length, 1)
  assert.equal(triggers.allow('session-b', 'session-a').ok, true)

  triggers.observeClaimed('session-b', sent.deliveryId, 1)
  triggers.observeUserMessage('session-b', sent.deliveryId, null)
  const reply = field(
    await triggers.reply('session-b', {
      correlationId: sent.correlationId,
      text: 'relay',
      idempotencyKey: 'r1',
      targetSessionId: 'session-forged',
    }),
    'hop',
  )
  assert.equal(reply.hop, 2)
  assert.equal(pushed[1].sessionId, 'session-a')
  triggers.observeClaimed('session-a', reply.deliveryId, 2)
  triggers.observeUserMessage('session-a', reply.deliveryId, null)
  const stopped = field(
    await triggers.reply('session-a', {
      correlationId: sent.correlationId,
      text: 'relay',
      idempotencyKey: 'r2',
    }),
    'code',
  )
  assert.equal(stopped.code, 'HOP_LIMIT')
  assert.equal(pushed.length, 2)

  const hook = field(triggers.registerWebhook('session-b'), 'hook')
  assert.equal(JSON.stringify(hook).includes(readFileSync(hook.hook.secretFile, 'utf8')), false)
  const secret = readFileSync(hook.hook.secretFile, 'utf8')
  const raw = Buffer.from('{"n":1}')
  const timestamp = String(Math.floor(Date.parse('2026-11-08T00:00:00.000Z') / 1000))
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${raw.toString('utf8')}`)
    .digest('hex')
  const bad = await triggers.acceptWebhook(hook.hook.id, raw, { timestamp, signature: '00', eventId: 'e1' })
  assert.equal(bad.http, 401)
  const expired = await triggers.acceptWebhook(hook.hook.id, raw, {
    timestamp: String(Math.floor(Date.parse('2026-11-08T00:00:00.000Z') / 1000) - 600),
    signature,
    eventId: 'e1',
  })
  assert.equal(expired.http, 401)
  const accepted = await triggers.acceptWebhook(hook.hook.id, raw, { timestamp, signature, eventId: 'e1' })
  assert.equal(accepted.http, 202)
  assert.equal(field(accepted.body, 'status').status, 'accepted')
  const duplicate = await triggers.acceptWebhook(hook.hook.id, raw, { timestamp, signature, eventId: 'e1' })
  assert.equal(field(duplicate.body, 'duplicate').duplicate, true)
  const webhookPushes = pushed.filter(item => item.text.includes('[foundations:webhook]'))
  assert.equal(webhookPushes.length, 1)
  assert.match(webhookPushes[0].text, /untrusted/)

  const timer = triggers.addSchedule({
    sessionId: 'session-a',
    kind: 'one-shot',
    runAt: '2026-11-08T00:00:00.000Z',
    note: 'ring once',
  })
  assert.equal(timer.ok, true)
  await triggers.tick()
  await triggers.tick()
  const timerPushes = pushed.filter(item => item.text.includes('[foundations:timer]'))
  assert.equal(timerPushes.length, 1)

  store.db.prepare(`UPDATE deliveries SET status = 'flushing', flush_pid = 7 WHERE id = ?`).run(sent.deliveryId)
  const before = pushed.length
  await triggers.reconcile()
  assert.equal(pushed.length, before)
  const row = store.db.prepare('SELECT status FROM deliveries WHERE id = ?').get(sent.deliveryId)
  assert.equal(row.status, 'accepted')

  store.db.prepare(`UPDATE deliveries SET status = 'completed' WHERE status IN ('claimed','started')`).run()
  const held = field(
    await triggers.send('session-a', { targetSessionId: 'session-b', text: 'hold', idempotencyKey: 'hold-1' }),
    'deliveryId',
  )
  assert.equal(held.status, 'accepted')
  store.db.prepare(`UPDATE deliveries SET status = 'ambiguous', flush_pid = 42 WHERE id = ?`).run(held.deliveryId)
  present.delete(held.deliveryId)
  const heldBefore = pushed.length
  await triggers.reconcile()
  assert.equal(pushed.length, heldBefore)
  store.db.prepare(`UPDATE deliveries SET flush_pid = 7 WHERE id = ?`).run(held.deliveryId)
  await triggers.reconcile()
  assert.equal(pushed.length, heldBefore + 1)
  store.close()
})
