import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'
import { toolDefinitions } from '../src/tools.ts'

test('missing host session and export failure stay explicit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tools-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const tool = toolDefinitions(engine, () => 1).find(item => item.name === 'foundations_remember')
  if (tool === undefined) throw new Error('foundations_remember is not registered')
  const missing = await tool.execute({ target: 'fact', content: 'x', idempotencyKey: 'k' }, {})
  assert.equal(missing.code, 'UNAVAILABLE')
  store.close()
})

test('fork binding does not copy the parent rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-fork-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  engine.ensureSession('session-parent')
  store.db
    .prepare(`
    INSERT INTO facts (
      session_id, content, status, source_type, revision, priority, created_at, updated_at
    ) VALUES ('session-parent', 'a parent-session fact', 'active', 'explicit_tool', 1, 100, ?, ?)
  `)
    .run(new Date().toISOString(), new Date().toISOString())
  engine.ensureSession('session-child', { parentSessionId: 'session-parent', seeded: true })
  const childFacts = store.db.prepare(`SELECT count(*) AS n FROM facts WHERE session_id = 'session-child'`).get() as {
    n: number
  }
  assert.equal(childFacts.n, 0)
  const binding = engine.binding('session-child')
  if (binding === null) throw new Error('session-child has no binding')
  assert.equal(binding.fork_parent_session_id, 'session-parent')
  assert.equal(binding.fork_seeded, 1)
  store.close()
})
