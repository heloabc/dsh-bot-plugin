import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { forgetWorkspaceId, projectKey, purgeSessionFiles, sessionDirectory } from '../src/session-files.ts'

test('project key matches the session directory name encoding', () => {
  const key = projectKey('/opt/project/web/dsh-plugins/.run/state/workspace')
  assert.equal(key, '--opt-project-web-dsh-plugins-.run-state-workspace--')
})

test('purge removes only that session directory and its archive id', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bot-sessions-'))
  const cwd = '/tmp/workspace'
  const id = 'session-blank-1'
  const dir = sessionDirectory(root, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'log')
  const other = sessionDirectory(root, cwd, 'session-keep')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'session.v4.jsonl.zstd'), 'keep')
  const cache = join(root, `${id}.json`)
  writeFileSync(cache, '{}')
  const workspace = join(root, 'workspace.json')
  writeFileSync(
    workspace,
    JSON.stringify({
      global: { archivedSessionIds: [id, 'session-keep'] },
      tables: { workspaces: { a: { sessionIds: [id, 'session-keep'] } } },
    }),
  )
  purgeSessionFiles({ sessionsRoot: root, cacheFile: cache, workspaceFile: workspace, sessionId: id, cwd })
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(other), true)
  assert.equal(existsSync(cache), false)
  const stored = JSON.parse(readFileSync(workspace, 'utf8'))
  assert.deepEqual(stored.global.archivedSessionIds, ['session-keep'])
  assert.deepEqual(stored.tables.workspaces.a.sessionIds, ['session-keep'])
})

test('purge refuses a session directory that is a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bot-sessions-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-bot-outside-'))
  writeFileSync(join(outside, 'keep'), 'secret')
  const cwd = '/tmp/workspace'
  const id = 'session-link'
  const dir = sessionDirectory(root, cwd, id)
  mkdirSync(join(dir, '..'), { recursive: true })
  symlinkSync(outside, dir)
  assert.throws(
    () =>
      purgeSessionFiles({
        sessionsRoot: root,
        cacheFile: '',
        workspaceFile: join(root, 'missing.json'),
        sessionId: id,
        cwd,
      }),
    /symlink/,
  )
  assert.equal(existsSync(join(outside, 'keep')), true)
})

test('forgetWorkspaceId leaves a file without an archive list untouched aside from formatting', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bot-ws-'))
  const file = join(root, 'workspace.json')
  writeFileSync(file, '{"global":{"pinnedSessionIds":[]}}\n')
  forgetWorkspaceId(file, 'session-x')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { global: { pinnedSessionIds: [] } })
})
