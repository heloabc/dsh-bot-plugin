import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { describe } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { dshBin, nodeBin } from './dsh-bin.ts'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = nodeBin()
const DSH = dshBin(ROOT)

function assertHost() {
  assert.ok(DSH && existsSync(DSH), 'set DSH_BIN to the @deepseek-ai/dsh@0.2.2-rc.1 bin.js')
  const pkg = JSON.parse(readFileSync(join(DSH, '../../package.json'), 'utf8'))
  assert.equal(pkg.version, '0.2.2-rc.1')
}

let nextPort = 34000 + (process.pid % 1000)

async function withHost(
  run: (ctx: {
    box: { child: any }
    origin: string
    cookie: string
    sessionA: string
    sessionB: string
    home: string
    work: string
    env: NodeJS.ProcessEnv
    patch: string
    port: number
  }) => Promise<void>,
) {
  assertHost()
  const port = nextPort
  nextPort += 1
  const home = mkdtempSync(join(tmpdir(), 'sf-trig-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sf-trig-work-'))
  const patch = join(work, 'patch.yml')
  writeFileSync(
    patch,
    `
- id: agent-default-model
  config:
    provider: foundations-mock
    model: mock-1
- insert:
    - id: foundations-mock
      name: ${JSON.stringify(join(ROOT, 'fixtures/mock-llm.mjs'))}
    - id: session-foundations
      name: ${JSON.stringify(join(ROOT, 'dist/index.js'))}
      config:
        traceEvents: true
        contextWindow: 128000
        timerTickMs: 400
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const origin = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    HOME: home,
    PATH: process.env.PATH,
  }
  delete env.SESSION_FOUNDATIONS_CRASH_BEFORE_FLUSH
  const box = { child: start(env, patch, port, join(work, 'dsh.log')) }
  try {
    const cookie = await boot(box.child, join(work, 'dsh.log'), origin)
    const sessionA = await makeSession(origin, cookie, work)
    const sessionB = await makeSession(origin, cookie, work)
    await plugin(origin, cookie, '/session-foundations/api/messages/allow', {
      targetSessionId: sessionB,
      senderSessionId: sessionA,
    })
    await plugin(origin, cookie, '/session-foundations/api/messages/allow', {
      targetSessionId: sessionA,
      senderSessionId: sessionB,
    })
    await run({ box, origin, cookie, sessionA, sessionB, home, work, env, patch, port })
  } finally {
    await stop(box.child)
  }
}

describe('real DSH inbox', { concurrency: 1 }, () => {
  test('message relay ignores a forged sender and stops the hop chain', { timeout: 120000 }, async () => {
    await withHost(async ({ origin, cookie, sessionA, sessionB }) => {
      const denied = await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: 'session-stranger',
        targetSessionId: sessionB,
        text: 'no',
        idempotencyKey: 'deny-1',
      }).catch(error => error)
      assert.match(String(denied.message ?? denied.code ?? ''), /FORBIDDEN|400/)

      await promptAndWait(
        origin,
        cookie,
        sessionA,
        `FOUNDATIONS_TOOL foundations_send ${JSON.stringify({
          targetSessionId: sessionB,
          text: 'ordinary',
          idempotencyKey: 'tool-1',
          sessionId: sessionB,
        })}`,
      )
      const forged = await pluginGet(
        origin,
        cookie,
        `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionA)}`,
      )
      const forgedRow = forged.deliveries.find(
        (row: any) => row.sender_session_id === sessionA && row.hop === 1 && row.kind === 'message',
      )
      assert.ok(forgedRow)
      assert.equal(forgedRow.sender_session_id, sessionA)
      assert.notEqual(forgedRow.sender_session_id, sessionB)

      const relay = await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: sessionA,
        targetSessionId: sessionB,
        text: 'relay',
        idempotencyKey: 'relay-1',
      })
      assert.equal(
        relay.status === 'accepted' ||
          relay.status === 'claimed' ||
          relay.status === 'started' ||
          relay.status === 'completed',
        true,
      )
      const chain = await poll(async () => {
        const page = await pluginGet(
          origin,
          cookie,
          `/session-foundations/api/deliveries?correlationId=${encodeURIComponent(relay.correlationId)}`,
        )
        const hops = page.deliveries.filter((row: any) => row.kind === 'message')
        const rejected = hops.some((row: any) => row.status === 'rejected')
        return rejected ? hops : null
      })
      assert.ok(
        chain.some(
          (row: any) => row.hop === 2 && row.sender_session_id === sessionB && row.target_session_id === sessionA,
        ),
      )
      assert.ok(chain.some((row: any) => row.status === 'rejected' && row.hop === 5))
      assert.equal(
        chain.some((row: any) => row.hop > 5 && row.status === 'accepted'),
        false,
      )
    })
  })

  test('a message sent while the target is busy lands on the next turn', { timeout: 120000 }, async () => {
    await withHost(async ({ origin, cookie, sessionA, sessionB }) => {
      await prompt(origin, cookie, sessionA, 'FOUNDATIONS_DELAY 1200')
      await delay(200)
      const busy = await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: sessionB,
        targetSessionId: sessionA,
        text: 'queue while busy',
        idempotencyKey: 'busy-1',
      })
      await rpc(origin, cookie, 'session/wait', { request: { sessionId: sessionA, timeoutMs: 20000 } })
      const eventsA = await eventsOf(origin, cookie, sessionA)
      const splices = eventsA.filter(
        (event: any) => event!.type === 'agent/inbox/spliced' && JSON.stringify(event!.data).includes(busy.deliveryId),
      )
      assert.ok(splices.length >= 1)
      assert.equal(
        splices.every((event: any) => event!.data?.target === 'next-turn'),
        true,
      )
    })
  })

  test('webhook receipts dedupe and reject a bad signature', { timeout: 120000 }, async () => {
    await withHost(async ({ origin, cookie, sessionA }) => {
      const hook = await plugin(origin, cookie, '/session-foundations/api/webhooks', { targetSessionId: sessionA })
      const secret = readFileSync(hook.hook.secretFile, 'utf8')
      assert.equal(JSON.stringify(hook).includes(secret), false)
      const raw = Buffer.from('{"ping":1}')
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${raw.toString('utf8')}`)
        .digest('hex')
      const first = await hookPost(origin, cookie, hook.hook.id, raw, { timestamp, signature, eventId: 'evt-1' })
      const second = await hookPost(origin, cookie, hook.hook.id, raw, { timestamp, signature, eventId: 'evt-1' })
      const bad = await hookPost(origin, cookie, hook.hook.id, raw, { timestamp, signature: 'aa', eventId: 'evt-2' })
      const old = await hookPost(origin, cookie, hook.hook.id, raw, {
        timestamp: String(Math.floor(Date.now() / 1000) - 600),
        signature,
        eventId: 'evt-3',
      })
      assert.equal(first.status, 202)
      assert.equal(second.body.duplicate, true)
      assert.equal(bad.status, 401)
      assert.equal(old.status, 401)
      const hookRows = await pluginGet(
        origin,
        cookie,
        `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionA)}`,
      )
      assert.equal(hookRows.deliveries.filter((row: any) => row.kind === 'webhook').length, 1)
    })
  })

  test('a one-shot timer fires once', { timeout: 120000 }, async () => {
    await withHost(async ({ origin, cookie, sessionA }) => {
      const runAt = new Date(Date.now() + 800).toISOString()
      const timer = await plugin(origin, cookie, '/session-foundations/api/timers', {
        sessionId: sessionA,
        kind: 'one-shot',
        runAt,
        note: 'later',
      })
      assert.equal(timer.ok, true)
      const fired = await poll(async () => {
        const page = await pluginGet(
          origin,
          cookie,
          `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionA)}`,
        )
        const rows = page.deliveries.filter((row: any) => row.kind === 'timer')
        return rows.length >= 1 ? rows : null
      })
      assert.equal(fired.length, 1)
    })
  })

  test('restart does not fire the same timer again and still accepts a message', { timeout: 120000 }, async () => {
    await withHost(async ctx => {
      const { origin, sessionA, sessionB, work, env, patch, port, box } = ctx
      let cookie = ctx.cookie
      const runAt = new Date(Date.now() + 800).toISOString()
      const timer = await plugin(origin, cookie, '/session-foundations/api/timers', {
        sessionId: sessionA,
        kind: 'one-shot',
        runAt,
        note: 'later',
      })
      assert.equal(timer.ok, true)
      const fired = await poll(async () => {
        const page = await pluginGet(
          origin,
          cookie,
          `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionA)}`,
        )
        const rows = page.deliveries.filter((row: any) => row.kind === 'timer')
        return rows.length >= 1 ? rows : null
      })
      assert.equal(fired.length, 1)
      await stop(box.child)
      box.child = start(env, patch, port, join(work, 'dsh-restart.log'))
      cookie = await boot(box.child, join(work, 'dsh-restart.log'), origin)
      const timers = await pluginGet(
        origin,
        cookie,
        `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionA)}`,
      )
      assert.equal(timers.deliveries.filter((row: any) => row.kind === 'timer').length, 1)
      const cold = await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: sessionA,
        targetSessionId: sessionB,
        text: 'cold start',
        idempotencyKey: 'cold-1',
      })
      assert.equal(cold.ok, true)
      const eventsB = await eventsOf(origin, cookie, sessionB)
      assert.ok(eventsB.some((event: any) => JSON.stringify(event!.data ?? {}).includes('cold start')))
    })
  })

  test('a crash before flush is recovered on the next process', { timeout: 180000 }, async () => {
    await withHost(async ctx => {
      const { origin, sessionA, sessionB, home, work, env, patch, port, box } = ctx
      await stop(box.child)
      const crashEnv = { ...env, SESSION_FOUNDATIONS_CRASH_BEFORE_FLUSH: '1' }
      box.child = start(crashEnv, patch, port, join(work, 'dsh-crash.log'))
      let cookie = await boot(box.child, join(work, 'dsh-crash.log'), origin)
      await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: sessionA,
        targetSessionId: sessionB,
        text: 'crash boundary',
        idempotencyKey: 'crash-1',
      }).catch(() => {})
      await delay(500)
      await stop(box.child)
      box.child = start(env, patch, port, join(work, 'dsh-recover.log'))
      cookie = await boot(box.child, join(work, 'dsh-recover.log'), origin)
      const recovered = await poll(async () => {
        const page = await pluginGet(
          origin,
          cookie,
          `/session-foundations/api/deliveries?sessionId=${encodeURIComponent(sessionB)}`,
        )
        const row = page.deliveries.find(
          (item: any) =>
            item.kind === 'message' &&
            item.sender_session_id === sessionA &&
            item.hop === 1 &&
            item.status !== 'intent' &&
            item.status !== 'flushing',
        )
        const db = new DatabaseSync(join(home, 'profiles', 'web', 'session-foundations', 'persona.sqlite'), {
          readOnly: true,
        })
        const crashRow = db
          .prepare(
            `SELECT id, status, last_error, attempts, splice_seq FROM deliveries WHERE idempotency_key = 'crash-1'`,
          )
          .get()
        db.close()
        if (!crashRow) return null
        if (crashRow.status === 'intent' || crashRow.status === 'flushing' || crashRow.status === 'ambiguous')
          return null
        return { crashRow, sample: row }
      }, 45000)
      const settled = await poll(async () => {
        const eventsB = await eventsOf(origin, cookie, sessionB)
        const splices = eventsB.filter(
          (event: any) =>
            event!.type === 'agent/inbox/spliced' && JSON.stringify(event!.data).includes(recovered.crashRow.id),
        )
        return splices.length > 0 ? splices : null
      }, 45000)
      assert.equal(
        settled.length,
        1,
        JSON.stringify({
          status: recovered.crashRow.status,
          error: recovered.crashRow.last_error,
          attempts: recovered.crashRow.attempts,
        }),
      )
      const again = await plugin(origin, cookie, '/session-foundations/api/messages/send', {
        senderSessionId: sessionA,
        targetSessionId: sessionB,
        text: 'crash boundary',
        idempotencyKey: 'crash-1',
      })
      assert.equal(again.deliveryId, recovered.crashRow.id)
      const eventsAfter = await eventsOf(origin, cookie, sessionB)
      const splicesAfter = eventsAfter.filter(
        (event: any) =>
          event!.type === 'agent/inbox/spliced' && JSON.stringify(event!.data).includes(recovered.crashRow.id),
      )
      assert.equal(splicesAfter.length, 1)
    })
  })
})

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} patch
 * @param {number} port
 * @param {string} logPath
 */
function start(env: any, patch: any, port: any, logPath: any) {
  const child = spawn(
    NODE,
    [DSH, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', chunk => writeFileSync(logPath, chunk, { flag: 'a' }))
  child.stderr.on('data', chunk => writeFileSync(logPath, chunk, { flag: 'a' }))
  return child
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 * @param {string} origin
 */
async function boot(child: any, logPath: any, origin: any) {
  const token = await waitForToken(child, logPath)
  return exchange(origin, token)
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 */
async function waitForToken(child: any, logPath: any) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    if (child.exitCode != null)
      throw new Error(
        `dsh exited ${child.exitCode}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : ''}`,
      )
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const match = /token=([A-Za-z0-9._~+-]+)/.exec(log)
    if (match) return match[1]
    if (/Error|failed to/i.test(log) && /plugin|session-foundations|mock/.test(log)) throw new Error(log.slice(-4000))
    await delay(200)
  }
  throw new Error(`timed out\n${existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : ''}`)
}

/**
 * @param {string} origin
 * @param {string} token
 */
async function exchange(origin: any, token: any) {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ')
  if (cookie === '') throw new Error(`token exchange HTTP ${response.status}`)
  return cookie
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} work
 */
async function makeSession(origin: any, cookie: any, work: any) {
  const created = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
  const sessionId = created.result?.value?.sessionId
  assert.equal(typeof sessionId, 'string')
  await rpc(origin, cookie, 'session/selectModel', {
    request: { sessionId, provider: 'foundations-mock', model: 'mock-1' },
  })
  await plugin(origin, cookie, '/session-foundations/api/sessions/mark', { sessionId })
  return sessionId
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} method
 * @param {Record<string, unknown>} args
 */
async function rpc(origin: any, cookie: any, method: any, args: any) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  const body = await response.json()
  if (body?.result?.ok === false)
    throw new Error(`${method} failed ${JSON.stringify(body.result.error ?? body).slice(0, 800)}`)
  return { result: body?.result }
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} path
 * @param {unknown} body
 */
async function plugin(origin: any, cookie: any, path: any, body: any) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie, origin },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${path} HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} path
 */
async function pluginGet(origin: any, cookie: any, path: any) {
  const response = await fetch(`${origin}${path}`, { headers: { accept: 'application/json', cookie, origin } })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 400)}`)
  return json
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 * @param {string} text
 */
async function prompt(origin: any, cookie: any, sessionId: any, text: any) {
  await rpc(origin, cookie, 'session/prompt', {
    request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  })
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 * @param {string} text
 */
async function promptAndWait(origin: any, cookie: any, sessionId: any, text: any) {
  await prompt(origin, cookie, sessionId, text)
  const waited = await rpc(origin, cookie, 'session/wait', { request: { sessionId, timeoutMs: 20000 } })
  if (waited.result?.value?.reason === 'timeout') throw new Error(`turn timed out ${text.slice(0, 80)}`)
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} id
 * @param {Buffer} raw
 * @param {{ timestamp: string, signature: string, eventId: string }} headers
 */
async function hookPost(origin: any, cookie: any, id: any, raw: any, headers: any) {
  const response = await fetch(`${origin}/session-foundations/hooks/${id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-foundations-timestamp': headers.timestamp,
      'x-foundations-signature': headers.signature,
      'x-foundations-event-id': headers.eventId,
    },
    body: raw,
  })
  const text = await response.text()
  let body: Record<string, any> = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return { status: response.status, body }
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 */
async function eventsOf(origin: any, cookie: any, sessionId: any) {
  const page = await rpc(origin, cookie, 'session/events', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 800 },
  })
  const value = page.result?.value ?? page.result
  const records = value?.records ?? []
  return records.map((record: any) => (record?.type === 'event' && record.event ? record.event : record))
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {number} [ms]
 */
async function poll(fn: any, ms = 20000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < ms) {
    last = await fn()
    if (last) return last
    await delay(250)
  }
  throw new Error(`poll timeout ${JSON.stringify(last)?.slice(0, 500)}`)
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
async function stop(child: any) {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  const started = Date.now()
  while (child.exitCode == null && Date.now() - started < 8000) await delay(100)
  if (child.exitCode == null) child.kill('SIGKILL')
}
