import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'
import { toolDefinitions } from '../src/tools.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-skill-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  engine.ensureSession('session-a')
  engine.ensureSession('session-b')
  return { dir, store, engine }
}

test('private skill stays in its session and revocation is immediate', async () => {
  const { store, engine } = setup()
  const root = join(store.root, 'src', 'skills', 'private', 'session-a', 'taste')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'SKILL.md'),
    '---\nversion: 1.2.0\ndescription: taste notes\n---\nRecord taste only. Do not grant tools.\n',
  )
  const row = engine.registerSkillFromDisk('session-a', 'private', 'taste')
  assert.equal(row.version, '1.2.0')
  const tools = Object.fromEntries(toolDefinitions(engine, () => 1).map(item => [item.name, item]))
  const loaded = await tools.foundations_skill_load.execute(
    { skillId: 'taste', sessionId: 'session-b' },
    { agent: { id: 'session-a' } },
  )
  assert.equal(loaded.ok, true)
  assert.equal(loaded.data.grantsTools, false)
  const other = await tools.foundations_skill_load.execute({ skillId: 'taste' }, { agent: { id: 'session-b' } })
  assert.equal(other.ok, false)
  assert.equal(other.code, 'NOT_FOUND')
  engine.setSkillFlags('session-a', 'taste', { revoked: true })
  const revoked = await tools.foundations_skill_load.execute({ skillId: 'taste' }, { agent: { id: 'session-a' } })
  assert.equal(revoked.code, 'REVOKED')
  store.close()
})

test('symlink and parent escape are refused', () => {
  const { dir, store, engine } = setup()
  const outside = join(dir, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'SKILL.md'), 'secret')
  const linkRoot = join(store.root, 'src', 'skills', 'public', 'escape')
  mkdirSync(join(store.root, 'src', 'skills', 'public'), { recursive: true })
  symlinkSync(outside, linkRoot)
  assert.throws(
    () => engine.registerSkillFromDisk('session-a', 'public', 'escape'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  )
  const dot = join(store.root, 'src', 'skills', 'public', '..', '..', 'outside', 'SKILL.md')
  assert.throws(
    () => engine.registerSkillFromDisk('session-a', 'public', '..'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && (error.code === 'VALIDATION' || error.code === 'FORBIDDEN'),
  )
  assert.ok(dot)
  store.close()
})

test('changed blob is a hash mismatch', async () => {
  const { store, engine } = setup()
  engine.registerSkill('session-a', 'public', 'note', '1', 'short', Buffer.from('body'))
  const row = engine.skillRow('session-a', 'note')
  writeFileSync(join(store.root, 'blobs', 'skills', row.content_hash, 'SKILL.md'), 'edited')
  const tools = Object.fromEntries(toolDefinitions(engine, () => 1).map(item => [item.name, item]))
  const result = await tools.foundations_skill_load.execute({ skillId: 'note' }, { agent: { id: 'session-a' } })
  assert.equal(result.code, 'HASH_MISMATCH')
  store.close()
})
