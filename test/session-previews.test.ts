import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openSessionPreviews } from '../src/session-previews.ts'

test('a preview is reloaded from the same file and a bad row is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-previews-'))
  const file = join(dir, 'session-previews.json')
  try {
    const first = openSessionPreviews(file)
    const saved = first.remember('session-abc', '  what time \n now ')
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    assert.equal(saved.preview, 'what time now')
    const second = openSessionPreviews(file)
    assert.equal(second.all()['session-abc'], 'what time now')
    assert.deepEqual(second.remember('nope', 'x'), { ok: false, error: 'bad_session' })
    assert.deepEqual(second.remember('session-abc', '   '), { ok: false, error: 'empty_preview' })
    const long = second.remember('session-abc', 'a'.repeat(200))
    assert.equal(long.ok, true)
    if (!long.ok) return
    assert.equal(long.preview!.length, 80)
    assert.equal(
      second.rememberAll({
        'session-kept': 'kept',
        '../etc': 'no',
        'session-blank': '   ',
      }).stored,
      1,
    )
    assert.equal(second.all()['session-kept'], 'kept')
    assert.equal(second.all()['../etc'], undefined)
    second.forget('session-abc')
    assert.equal(second.all()['session-abc'], undefined)
    assert.equal(openSessionPreviews(file).all()['session-abc'], undefined)
    assert.equal(openSessionPreviews(file).all()['session-kept'], 'kept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
