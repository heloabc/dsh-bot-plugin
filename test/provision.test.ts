import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { provisionSession } from '../src/provision.ts'
import { openStore } from '../src/store.ts'

function tempEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-provision-'))
  const store = openStore(dir)
  return { store, engine: createEngine(store) }
}

test('a new session binds the latest persona and does not copy facts', async () => {
  const { store, engine } = tempEngine()
  const persona = engine.confirmPersona('You are a brief assistant. Call the user Ada.')
  engine.markBot('session-old')
  engine.bindPersona('session-old', persona.id)
  await provisionSession(engine, {
    sessionId: 'session-old',
    fact: 'The user is called Ada',
    idempotencyKey: 'old-fact',
  })
  engine.markBot('session-new')
  const opened = await provisionSession(engine, { sessionId: 'session-new' })
  assert.equal(opened.ok, true)
  assert.equal(opened.fact, null)
  const binding = engine.binding('session-new')
  assert.equal(binding.persona_version_id, persona.id)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM facts WHERE session_id = ?').get('session-new').n, 0)
  store.close()
})

test('typed persona and fact land on the new session only', async () => {
  const { store, engine } = tempEngine()
  engine.confirmPersona('the old persona')
  engine.markBot('session-new')
  const opened = await provisionSession(engine, {
    sessionId: 'session-new',
    personaText: 'the new persona',
    fact: 'The user is called Ada',
    idempotencyKey: 'k1',
  })
  assert.equal(opened.ok, true)
  assert.equal(opened.fact.outcome, 'applied')
  assert.equal(engine.binding('session-new').persona_version_id, engine.latestPersona().id)
  const body = store.readBlob('persona', engine.latestPersona().content_hash)!.toString('utf8')
  assert.equal(body, 'the new persona')
  assert.equal(
    store.db.prepare('SELECT content FROM facts WHERE session_id = ?').get('session-new').content,
    'The user is called Ada',
  )
  const replay = await provisionSession(engine, {
    sessionId: 'session-new',
    fact: 'The user is called Ada',
    idempotencyKey: 'k1',
  })
  assert.equal(replay.fact.outcome, 'replayed')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM facts WHERE session_id = ?').get('session-new').n, 1)
  store.close()
})

test('an ordinary session cannot receive a persona', async () => {
  const { store, engine } = tempEngine()
  engine.ensureSession('session-plain')
  const opened = await provisionSession(engine, { sessionId: 'session-plain', personaText: 'Name: Scout' })
  assert.equal(opened.ok, false)
  assert.equal(opened.code, 'FORBIDDEN')
  assert.equal(engine.isBot('session-plain'), false)
  assert.equal(engine.binding('session-plain').persona_version_id, null)
  assert.equal(engine.latestPersona(), null)
  store.close()
})

test('opening a session requires an id', async () => {
  const { store, engine } = tempEngine()
  const opened = await provisionSession(engine, {})
  assert.equal(opened.ok, false)
  assert.equal(opened.code, 'VALIDATION')
  store.close()
})
