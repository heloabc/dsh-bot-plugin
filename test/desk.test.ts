import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDesk } from '../src/desk.ts'
import { openLedger } from '../src/desk-ledger.ts'

const API = '/session-foundations/api'

test('ledger reuses an idempotency key and does not mint a second task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-ledger-'))
  const ledger = openLedger(join(dir, 'ledger.json'))
  const first = ledger.rememberTask('task-key-1', {
    sessionId: 'session-a',
    status: 'blocked_unconfigured',
    reason: 'unconfigured',
  })
  const second = ledger.rememberTask('task-key-1', { sessionId: 'session-b', status: 'accepted', reason: '' })
  assert.equal(second.created, false)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.sessionId, 'session-a')
  rmSync(dir, { recursive: true, force: true })
})

test('desk creates a bot, archives only blanks, and does not prompt without a model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-desk-'))
  const seen: any[] = []
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: () => false,
    mark: (sessionId: any) => ({ kind: 'bot', session_id: sessionId }),
    hold: () => {},
    release: () => {},
    usage: async () => ({
      connected: false,
      code: 'usage_unconfigured',
      error: 'OLLAMA_API_KEY is not available',
      token: 'hide-me',
    }),
    rpc: async (endpoint: any, args: any) => {
      seen.push(endpoint)
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: {
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 'session-abc', running: false, blank: true, cwd: '/work' },
                  { sessionId: 'session-kept', running: false, blank: false, cwd: '/work' },
                ],
              },
            },
          },
        }
      }
      if (endpoint === 'session/create') {
        return { status: 200, body: { result: { ok: true, value: { sessionId: 'session-created' } } } }
      }
      if (endpoint === 'workspace/archiveSession') {
        return { status: 200, body: { result: { ok: true, value: { archivedSessionIds: [args.request.sessionId] } } } }
      }
      if (endpoint === 'session/modelCatalog') {
        return { status: 200, body: { result: { ok: true, value: { routableProviders: [] } } } }
      }
      if (endpoint === 'session/prompt') throw new Error('prompt should not be called')
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    const created = await desk.handle(
      'POST',
      `${API}/sessions`,
      url('/sessions'),
      incoming({ name: 'Scout' }, { 'idempotency-key': 'create-key-1' }),
    )
    assert.equal(created.status, 201)
    assert.equal(created.body.sessionId, 'session-created')
    assert.equal(created.body.kind, 'bot')
    assert.match(created.body.marker, /bot\.json$/)
    assert.equal(existsSync(created.body.marker), true)
    const again = await desk.handle(
      'POST',
      `${API}/sessions`,
      url('/sessions'),
      incoming({}, { 'idempotency-key': 'create-key-1' }),
    )
    assert.equal(again.status, 200)
    assert.equal(again.body.reused, true)
    const listed = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(listed.body.result.value.items[0].sessionId, 'session-abc')
    const archived = await desk.handle('POST', `${API}/sessions/session-abc/archive`, url('/archive'), incoming({}))
    assert.equal(archived.status, 200)
    assert.deepEqual(archived.body.archivedSessionIds, ['session-abc'])
    const kept = await desk.handle('POST', `${API}/sessions/session-kept/archive`, url('/archive'), incoming({}))
    assert.equal(kept.status, 409)
    assert.equal(kept.body.error, 'not_blank')
    const absent = await desk.handle('POST', `${API}/sessions/session-missing/archive`, url('/archive'), incoming({}))
    assert.equal(absent.status, 404)
    const task = await desk.handle(
      'POST',
      `${API}/tasks`,
      url('/tasks'),
      incoming({ sessionId: 'session-created', text: 'do the thing' }, { 'idempotency-key': 'task-key-01' }),
    )
    assert.equal(task.status, 409)
    assert.equal(task.body.error, 'model_unconfigured')
    assert.equal(task.body.task.status, 'blocked_unconfigured')
    const repeat = await desk.handle(
      'POST',
      `${API}/tasks`,
      url('/tasks'),
      incoming({ sessionId: 'session-created', text: 'do the thing again' }, { 'idempotency-key': 'task-key-01' }),
    )
    assert.equal(repeat.body.task.id, task.body.task.id)
    assert.equal(seen.includes('session/prompt'), false)
    const usage = await desk.handle('GET', `${API}/usage`, url('/usage'), incoming())
    assert.equal(usage.body.connected, false)
    assert.match(usage.body.error, /OLLAMA_API_KEY/)
    assert.equal(usage.body.token, undefined)
    assert.equal(desk.owns('GET', `${API}/sessions/bots`), false)
    assert.equal(desk.owns('POST', `${API}/sessions/mark`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live bot turn is cancelled before the next prompt, and an idle turn is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-interrupt-'))
  const order: any[] = []
  let running = false
  let cancelOk = true
  let holdCancel = false
  let proceed: ((value?: unknown) => void) | null = null
  const wake = () => {
    proceed?.()
  }
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: (sessionId: any) => sessionId === 'session-bot',
    mark: (sessionId: any) => ({ kind: 'bot', session_id: sessionId }),
    hold: () => {
      order.push('hold')
    },
    release: () => {
      order.push('release')
    },
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any, args: any) => {
      if (endpoint === 'session/modelCatalog') {
        return { status: 200, body: { result: { ok: true, value: { routableProviders: [{ id: 'mock' }] } } } }
      }
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: {
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 'session-bot', running, cwd: join(dir, 'workspace') },
                  { sessionId: 'session-plain', running, cwd: join(dir, 'workspace') },
                ],
              },
            },
          },
        }
      }
      if (endpoint === 'session/cancel') {
        order.push('cancel')
        assert.equal(args.request.sessionId, 'session-bot')
        if (holdCancel) {
          await new Promise(resolve => {
            proceed = resolve
          })
        }
        running = false
        return {
          status: 200,
          body: { result: cancelOk ? { ok: true } : { ok: false, error: { code: 'busy', message: 'cancel failed' } } },
        }
      }
      if (endpoint === 'session/prompt') {
        order.push(`prompt:${args.request.content[0].text}`)
        return { status: 200, body: { result: { ok: true } } }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  const post = (key: any, sessionId: any, text: any) =>
    desk.handle('POST', `${API}/tasks`, url('/tasks'), incoming({ sessionId, text }, { 'idempotency-key': key }))
  try {
    running = false
    const idle = await post('idle-key-1', 'session-bot', 'hello')
    assert.equal(idle.status, 202)
    assert.deepEqual(order, ['prompt:hello'])

    order.length = 0
    running = true
    const first = await post('live-key-1', 'session-bot', 'the first line')
    assert.equal(first.status, 202)
    assert.equal(first.body.interrupted, true)
    assert.deepEqual(order, ['hold', 'cancel', 'prompt:the first line'])

    order.length = 0
    running = true
    const second = await post('live-key-2', 'session-bot', 'a revision')
    assert.equal(second.status, 202)
    assert.deepEqual(order, ['hold', 'cancel', 'prompt:a revision'])
    const tasks = await desk.handle('GET', `${API}/tasks`, url('/tasks'), incoming())
    const older = tasks.body.items.find((item: any) => item.reason === 'interrupted')
    assert.equal(older.status, 'cancelled')
    assert.equal(tasks.body.items.filter((item: any) => item.status === 'accepted').length, 1)

    order.length = 0
    running = true
    const plain = await post('plain-key-1', 'session-plain', 'a plain session')
    assert.equal(plain.status, 202)
    assert.deepEqual(order, ['prompt:a plain session'])

    order.length = 0
    running = true
    cancelOk = false
    const failed = await post('fail-key-01', 'session-bot', 'cancel failed')
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error, 'cancel_failed')
    assert.deepEqual(order, ['hold', 'cancel', 'release'])

    order.length = 0
    cancelOk = true
    running = true
    holdCancel = true
    const left = post('race-key-1', 'session-bot', 'said first')
    const right = post('race-key-2', 'session-bot', 'said second')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(order.filter(item => item === 'cancel').length, 1)
    holdCancel = false
    wake()
    const raced = await Promise.all([left, right])
    assert.equal(
      raced.every(item => item.status === 202),
      true,
    )
    assert.equal(order.filter(item => item === 'cancel').length, 1)
    assert.equal(order.filter(item => item.startsWith('prompt:')).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file preview reads a worker workspace and rejects a foreign session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-file-'))
  const reads: any[] = []
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any, args: any) => {
      if (endpoint !== 'workspaceFiles/read') return { status: 404, body: { result: { ok: false } } }
      reads.push({ scope: args.workspaceFileScopeId, path: args.path })
      const missing = args.path === 'missing.txt'
      return {
        status: 200,
        body: {
          result: missing
            ? { ok: false, error: { code: 'workspace-file/not-found', message: 'missing' } }
            : { ok: true, value: { text: '{\n  "name": "shiguang-coffee"\n}\n', eof: true, bytes: 32 } },
        },
      }
    },
  })
  const preview = (sessionId: any, path: any) =>
    desk.handle(
      'GET',
      `${API}/file`,
      new URL(
        `http://127.0.0.1${API}/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
      ),
      incoming(),
    )
  try {
    const worker = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', 'package.json')
    assert.equal(worker.status, 200)
    assert.equal(worker.body.path, 'package.json')
    assert.match(worker.body.text, /shiguang-coffee/)
    assert.equal(worker.body.eof, true)
    assert.deepEqual(reads[0], { scope: 'worker-ea04885a-66a7-4292-9560-986ab0e9576b', path: 'package.json' })
    const parent = await preview('session-2dfcc21a-a5d8-4d10-98f1-fd7c6f736e2d', 'src/App.jsx')
    assert.equal(parent.status, 200)
    const foreign = await preview('bot-ea04885a-66a7-4292-9560-986ab0e9576b', 'package.json')
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error, 'invalid_file')
    const escape = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', '../package.json')
    assert.equal(escape.status, 400)
    assert.equal(reads.length, 2)
    const missing = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', 'missing.txt')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'file_unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session preview is stored on disk, returned with the list, and dropped when that session is purged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-preview-desk-'))
  const listed = {
    status: 200,
    body: {
      result: { ok: true, value: { items: [{ sessionId: 'session-abc', running: false, blank: true, cwd: '/work' }] } },
    },
  }
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: '',
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any) => {
      if (endpoint === 'session/list') return listed
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    assert.equal(desk.owns('POST', `${API}/sessions/previews`), true)
    const saved = await desk.handle(
      'POST',
      `${API}/sessions/previews`,
      url('/sessions/previews'),
      incoming({ sessionId: 'session-abc', preview: 'what time' }),
    )
    assert.equal(saved.status, 200)
    assert.equal(saved.body.preview, 'what time')
    const sessions = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(sessions.body.previews['session-abc'], 'what time')
    const reopened = createDesk({
      ledgerFile: join(dir, 'desk-ledger.json'),
      profileDir: dir,
      sessionCwd: '',
      isBot: () => false,
      mark: () => ({ kind: 'bot' }),
      hold: () => {},
      release: () => {},
      usage: async () => ({ connected: false }),
      rpc: async () => listed,
    })
    const again = await reopened.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(again.body.previews['session-abc'], 'what time')
    const rejected = await desk.handle(
      'POST',
      `${API}/sessions/previews`,
      url('/sessions/previews'),
      incoming({ sessionId: '../x', preview: 'no' }),
    )
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error, 'bad_session')
    const purged = await desk.handle('POST', `${API}/sessions/session-abc/purge`, url('/purge'), incoming({}))
    assert.equal(purged.status, 200)
    const after = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(after.body.previews['session-abc'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * @param {string} path
 */
function url(path: any) {
  return new URL(`http://127.0.0.1${API}${path}`)
}

function incoming(body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return Object.assign(Readable.from(payload), { headers })
}
