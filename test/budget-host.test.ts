import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { dshBin, nodeBin } from './dsh-bin.ts'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = nodeBin()
const DSH = dshBin(ROOT)

/**
 * Real DSH 0.2.2-rc.1 with the mock provider (not a real model). The main step
 * cap is 2 so the old step/end cancel would have fired on both turns.
 */
test('real DSH host: main budget ends naturally, refuses step 3 at pre-step, never reports a user cancel', {
  timeout: 180000,
}, async () => {
  assert.ok(DSH !== '' && existsSync(DSH), 'set DSH_BIN to the @deepseek-ai/dsh@0.2.2-rc.1 bin.js')
  const home = mkdtempSync(join(tmpdir(), 'sf-budget-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sf-budget-work-'))
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
        contextWindow: 128000
        work:
          chatMaxSteps: 2
          mainMaxSteps: 2
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const port = 31993
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', HOME: home, PATH: process.env.PATH }
  delete (env as Record<string, unknown>).DSH_BOT_WORK_BUDGET
  const logPath = join(work, 'dsh.log')
  const child = start(env, patch, port, logPath)
  try {
    const token = await waitForToken(child, logPath)
    const cookie = await exchange(origin, token)
    const created = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
    const sessionId = created.result?.value?.sessionId
    assert.equal(typeof sessionId, 'string')
    await rpc(origin, cookie, 'session/selectModel', {
      request: { sessionId, provider: 'foundations-mock', model: 'mock-1' },
    })
    await plugin(origin, cookie, '/session-foundations/api/sessions/mark', { sessionId })

    // Turn 1: a tool on step 1 and the final text on step 2 (the VPS "几点了" shape).
    await promptAndWait(origin, cookie, sessionId, 'FOUNDATIONS_TOOL foundations_recall {"query":"name"}')
    // Turn 2: three host-tool steps requested; the cap is 2.
    const writes = [1, 2, 3]
      .map(n => `FOUNDATIONS_HOST_TOOL write {"file_path":${JSON.stringify(join(work, `f${n}.txt`))},"content":"${n}"}`)
      .join('\n')
    await promptAndWait(origin, cookie, sessionId, `[foundations:briefing]\n${writes}`)
    // The budget notice wakes one more turn after the refused one goes idle.
    let ends: any[] = []
    const started = Date.now()
    while (Date.now() - started < 30000) {
      await rpc(origin, cookie, 'session/wait', { request: { sessionId, timeoutMs: 5000 } })
      const events = await eventsOf(origin, cookie, sessionId)
      ends = events.filter((event: any) => event.type === 'turn/end')
      if (ends.length >= 3) break
      await delay(250)
    }
    const kinds = ends.map((event: any) => event.data?.reason?.kind)
    writeFileSync(join(work, 'turn-ends.json'), JSON.stringify(ends, null, 2))
    assert.equal(kinds[0], 'completed', `turn 1 ended ${JSON.stringify(ends[0]?.data)}`)
    assert.equal(kinds[1], 'blocked', `turn 2 ended ${JSON.stringify(ends[1]?.data)}`)
    assert.equal(kinds[2], 'completed', `notice turn ended ${JSON.stringify(ends[2]?.data)}`)
    assert.equal(
      ends.some((event: any) => event.data?.reason?.reason?.kind === 'user'),
      false,
      'no turn is recorded as a user cancel',
    )
    const events = await eventsOf(origin, cookie, sessionId)
    writeFileSync(join(work, 'events.json'), JSON.stringify(events, null, 2))
    const notices = events.filter(
      (event: any) =>
        event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('[foundations:budget]'),
    )
    assert.equal(notices.length, 1)
    assert.equal(existsSync(join(work, 'f1.txt')), true)
    assert.equal(existsSync(join(work, 'f2.txt')), true)
    const turn2Calls = events.filter((event: any) => event.type === 'tool/call' && event.data?.turn === 2)
    assert.equal(turn2Calls.length, 2, 'step 3 of turn 2 never started')
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /main budget main-budget:steps/)
  } finally {
    await stop(child)
  }
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
  return Object.assign(child, { logPath })
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 */
async function waitForToken(child: any, logPath: any) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    if (child.exitCode != null) {
      throw new Error(`dsh exited ${child.exitCode}\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
    }
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const match = /token=([A-Za-z0-9._~+-]+)/.exec(log)
    if (match) return match[1]
    if (/Error|failed to/i.test(log) && /plugin|session-foundations|mock/.test(log)) {
      throw new Error(log.slice(-4000))
    }
    await delay(250)
  }
  throw new Error(`timed out waiting for dsh\n${existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : ''}`)
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
 * @param {string} method
 * @param {Record<string, unknown>} args
 */
async function rpc(origin: any, cookie: any, method: any, args: any) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method} HTTP ${response.status} not json: ${text.slice(0, 500)}`)
  }
  if (body?.result?.ok === false) {
    throw new Error(`${method} failed ${JSON.stringify(body.result.error ?? body).slice(0, 800)}`)
  }
  return { status: response.status, result: body?.result }
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
    throw new Error(`${path} HTTP ${response.status} not json: ${text.slice(0, 500)}`)
  }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 * @param {string} text
 */
async function promptAndWait(origin: any, cookie: any, sessionId: any, text: any) {
  await rpc(origin, cookie, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
  const waited = await rpc(origin, cookie, 'session/wait', { request: { sessionId, timeoutMs: 20000 } })
  if (waited.result?.value?.reason === 'timeout') throw new Error(`turn timed out for ${text.slice(0, 80)}`)
  return waited
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 */
async function eventsOf(origin: any, cookie: any, sessionId: any) {
  const page = await rpc(origin, cookie, 'session/events', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 400 },
  })
  const value = page.result?.value ?? page.result
  const records = value?.records ?? value?.events ?? value?.items ?? []
  if (!Array.isArray(records)) return []
  return records.map(record => (record?.type === 'event' && record.event ? record.event : record))
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
