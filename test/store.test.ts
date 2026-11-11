import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../src/engine.ts'
import { openStore, restoreBackup } from '../src/store.ts'
import { toolDefinitions } from '../src/tools.ts'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-store-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  return { dir, store, engine }
}

test('a persona binding is promoted to a bot and is not copied onto a plain session', () => {
  const { store, engine } = tempStore()
  const persona = engine.confirmPersona('Name: Ernie')
  engine.ensureSession('session-plain')
  assert.equal(engine.binding('session-plain').kind, 'session')
  assert.equal(engine.binding('session-plain').persona_version_id, null)
  engine.bindPersona('session-bot', persona.id)
  store.db.prepare(`UPDATE session_bindings SET kind = 'session' WHERE session_id = ?`).run('session-bot')
  const report = engine.recover()
  assert.deepEqual(report.promoted, ['session-bot'])
  assert.equal(engine.isBot('session-bot'), true)
  assert.equal(engine.isBot('session-plain'), false)
  store.close()
})

test('persona confirm is immutable and a bad blob becomes an error', () => {
  const { store, engine } = tempStore()
  const persona = engine.confirmPersona('You are a brief assistant.', 'first')
  const again = engine.confirmPersona('You are a brief assistant.')
  assert.equal(again.id, persona.id)
  engine.bindPersona('session-a', persona.id)
  const file = join(store.root, 'blobs', 'persona', `${persona.content_hash}.md`)
  writeFileSync(file, 'tampered')
  const report = engine.recover()
  assert.equal(engine.binding('session-a').status, 'error')
  assert.equal(engine.binding('session-a').error_code, 'HASH_MISMATCH')
  assert.ok(report.errors.length >= 1)
  store.close()
})

test('backup api keeps the snapshot after later writes', async () => {
  const { dir, store, engine } = tempStore()
  engine.confirmPersona('a stable persona')
  const dest = join(dir, 'backups', 'one')
  await store.backupTo(dest)
  engine.confirmPersona('a later persona')
  store.close()
  const snap = new DatabaseSync(join(dest, 'persona.sqlite'), { readOnly: true })
  const rows = snap.prepare('SELECT count(*) AS n FROM persona_versions').get()
  assert.equal(rows!.n, 1)
  snap.close()
  const restored = join(dir, 'restored')
  await restoreBackup(restored, dest, null)
  const opened = openStore(restored)
  assert.equal(opened.db.prepare('SELECT count(*) AS n FROM persona_versions').get().n, 1)
  opened.close()
})

test('idempotency, cas, and foreign session id are host-scoped', async () => {
  const { store, engine } = tempStore()
  engine.ensureSession('session-a')
  engine.noteWatermark('session-a', '4')
  const tools = Object.fromEntries(toolDefinitions(engine, () => 2).map(item => [item.name, item]))
  const exec = { agent: { id: 'session-a' }, signal: new AbortController().signal }
  const first = await tools.foundations_remember.execute(
    {
      target: 'fact',
      content: 'The user is called Ada',
      idempotencyKey: 'k1',
      sessionId: 'session-b',
      sourceEventId: '9',
    },
    exec,
  )
  assert.equal(first.ok, false)
  assert.equal(first.code, 'VALIDATION')
  const savedArgs = {
    target: 'fact',
    content: 'The user is called Ada',
    idempotencyKey: 'k1',
    sessionId: 'session-b',
    priority: 300,
  }
  const saved = await tools.foundations_remember.execute(savedArgs, exec)
  assert.equal(saved.ok, true)
  assert.equal(saved.outcome, 'applied')
  assert.equal(saved.data.id > 0, true)
  const row = store.db.prepare('SELECT session_id FROM facts WHERE id = ?').get(saved.data.id)
  assert.equal(row.session_id, 'session-a')
  const replay = await tools.foundations_remember.execute(savedArgs, exec)
  assert.equal(replay.outcome, 'replayed')
  const clash = await tools.foundations_remember.execute(
    {
      target: 'fact',
      content: 'another fact',
      idempotencyKey: 'k1',
    },
    exec,
  )
  assert.equal(clash.code, 'IDEMPOTENCY_KEY_REUSE')
  const wrong = await tools.foundations_correct.execute(
    {
      target: 'fact',
      id: saved.data.id,
      content: 'The user is called Bea',
      expectedRevision: 9,
      idempotencyKey: 'c1',
    },
    exec,
  )
  assert.equal(wrong.code, 'CAS_CONFLICT')
  const fixed = await tools.foundations_correct.execute(
    {
      target: 'fact',
      id: saved.data.id,
      content: 'The user is called Bea',
      expectedRevision: 1,
      idempotencyKey: 'c1',
    },
    exec,
  )
  assert.equal(fixed.ok, true)
  const old = store.db.prepare('SELECT status FROM facts WHERE id = ?').get(saved.data.id)
  assert.equal(old.status, 'superseded')
  const forgotten = await tools.foundations_forget.execute(
    {
      target: 'fact',
      id: fixed.data.id,
      expectedRevision: 1,
      idempotencyKey: 'f1',
    },
    exec,
  )
  assert.equal(forgotten.ok, true)
  const recalled = await tools.foundations_recall.execute({ query: 'Bea' }, exec)
  assert.equal(recalled.data.facts.length, 0)
  const other = { agent: { id: 'session-b' }, signal: exec.signal }
  const hidden = await tools.foundations_recall.execute({ query: 'Ada', sessionId: 'session-a' }, other)
  assert.equal(hidden.data.facts.length, 0)
  store.close()
})

test('chinese substring fallback and state cas', async () => {
  const { store, engine } = tempStore()
  const tools = Object.fromEntries(toolDefinitions(engine, () => 1).map(item => [item.name, item]))
  const exec = { agent: { id: 'session-zh' }, signal: new AbortController().signal }
  await tools.foundations_remember.execute(
    {
      target: 'memory',
      title: 'taste',
      content: '用户喜欢吃小笼包',
      idempotencyKey: 'zh',
    },
    exec,
  )
  const found = await tools.foundations_recall.execute({ query: '小笼包' }, exec)
  assert.equal(found.data.memories.length, 1)
  assert.equal(found.data.strategy, 'substring')
  const updated = await tools.foundations_state_update.execute(
    {
      expectedRevision: 0,
      patch: { currentGoal: 'remember the taste', todos: [{ id: '1', text: 'buy soup dumplings', status: 'open' }] },
      idempotencyKey: 's1',
    },
    exec,
  )
  assert.equal(updated.ok, true)
  assert.equal(updated.storeRevision, 1)
  const lost = await tools.foundations_state_update.execute(
    {
      expectedRevision: 0,
      patch: { currentGoal: 'overwrite' },
      idempotencyKey: 's2',
    },
    exec,
  )
  assert.equal(lost.code, 'CAS_CONFLICT')
  store.close()
})

test('two writers either serialize or return BUSY', async () => {
  const { store, engine } = tempStore()
  engine.ensureSession('session-lock')
  const started = []
  const results: Array<{ ok: boolean; value?: any; code?: any }> = await Promise.all(
    [0, 1].map(index =>
      engine.store
        .write('session-lock', () => {
          started.push(index)
          const wait = Date.now() + 30
          while (Date.now() < wait) {
            /* hold the write lock */
          }
          engine.store.db
            .prepare(`
      INSERT INTO facts (
        session_id, content, status, source_type, revision, priority, created_at, updated_at
      ) VALUES ('session-lock', ?, 'active', 'explicit_tool', 1, 100, ?, ?)
    `)
            .run(`row-${index}`, new Date().toISOString(), new Date().toISOString())
          return index
        })
        .then((value: any) => ({ ok: true, value }))
        .catch((error: any) => ({ ok: false, code: error.code })),
    ),
  )
  assert.equal(results.filter(item => item.ok).length + results.filter(item => item.code === 'BUSY').length, 2)
  assert.ok(results.some(item => item.ok))
  store.close()
})
