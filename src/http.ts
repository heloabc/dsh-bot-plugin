import { createReadStream, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesk, defaultSessionCwd, type DeskRequest } from './desk.ts'
import type { HostContext } from './host.ts'
import { toolError } from './errors.ts'
import { sessionEvents } from './inbox.ts'
import { createSessionSnapshots, eventsBefore, eventsWindow, followTailStart } from './live-snapshot.ts'
import { provisionSession } from './provision.ts'
import { handleWorkApi, openPageLive, openWorkLive } from './work-http.ts'

/**
 * Local management routes. Model tools cannot confirm a persona or change revocation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./engine.js').Engine} engine
 * @param {() => import('./triggers.js').ReturnType<typeof import('./triggers.js').createTriggers> | null} [getRuntime]
 * @param {() => import('./work-worker.js').ReturnType<typeof import('./work-worker.js').createWorkRuntime> | null} [getWork]
 */
export function registerHttp(
  ctx: HostContext & { effect(execute: () => void | (() => void)): void },
  engine: import('./engine.ts').Engine,
  getRuntime: () => ReturnType<typeof import('./triggers.ts').createTriggers> | null = () => null,
  getWork: () => ReturnType<typeof import('./work-worker.ts').createWorkRuntime> | null = () => null,
  dataDir = '',
) {
  const webServer = ctx.webServer
  const storeDir = dataDir || (ctx.profileContext?.dir ? join(ctx.profileContext.dir, 'session-foundations') : '')
  const profileDir = ctx.profileContext?.dir || (storeDir !== '' ? dirname(storeDir) : '')
  const sessionSnapshots = createSessionSnapshots()
  const desk =
    profileDir === ''
      ? null
      : createDesk({
          ledgerFile: join(storeDir, 'desk-ledger.json'),
          profileDir,
          sessionCwd: defaultSessionCwd(process.env),
          isBot: sessionId => engine.isBot(sessionId),
          mark: sessionId => engine.markBot(sessionId),
          hold: sessionId => {
            getWork()?.holdNotices(sessionId)
          },
          release: sessionId => {
            getWork()?.releaseHold(sessionId)
          },
          rpc: (endpoint, args, req) => hostRpc(req, endpoint, args),
          usage: req => hostUsage(req),
        })
  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function loadPageDesk(req: import('node:http').IncomingMessage) {
    if (!desk) return null
    const base = 'http://127.0.0.1'
    const [sessions, health, usage] = await Promise.all([
      desk.handle('GET', '/session-foundations/api/sessions', new URL('/session-foundations/api/sessions', base), req),
      desk.handle('GET', '/session-foundations/api/health', new URL('/session-foundations/api/health', base), req),
      desk.handle('GET', '/session-foundations/api/usage', new URL('/session-foundations/api/usage', base), req),
    ])
    const bots = engine.listBots()
    return {
      sessions: sessions.body,
      health: health.status === 200 ? health.body : null,
      usage: usage.status === 200 ? usage.body : null,
      bots: { ok: true, sessionIds: bots.map(bot => bot.sessionId), bots },
    }
  }
  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const rejection = reject(ctx, req)
    if (rejection) return send(res, rejection, { ok: false, code: 'FORBIDDEN' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rawPath = url.pathname.replace(/\/+$/, '') || '/'
    if (rawPath === '/dsh-bot' || (rawPath.startsWith('/dsh-bot/') && !rawPath.startsWith('/dsh-bot/api'))) {
      if (serveDesk(req, res, rawPath)) return
      return send(res, 404, { ok: false, code: 'NOT_FOUND' })
    }
    const path = rawPath.startsWith('/dsh-bot/api')
      ? '/session-foundations/api' + rawPath.slice('/dsh-bot/api'.length)
      : rawPath
    try {
      if (desk && desk.owns(req.method ?? 'GET', path)) {
        const outcome = await desk.handle(req.method ?? 'GET', path, url, req)
        return send(res, outcome.status, outcome.body)
      }
      if (req.method === 'GET' && path === '/session-foundations/api/status') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        return send(res, 200, status(engine, sessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/mark') {
        const body = await readJson(req)
        if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '')
          return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        const binding = engine.markBot(body.sessionId.trim())
        return send(res, 200, { ok: true, kind: 'bot', sessionId: binding.session_id })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/sessions/bots') {
        const bots = engine.listBots()
        return send(res, 200, { ok: true, sessionIds: bots.map(bot => bot.sessionId), bots })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/open') {
        const body = await readJson(req)
        const opened = await provisionSession(engine, body)
        if (opened.ok === false) return send(res, 400, opened)
        return send(res, 200, {
          ...status(engine, opened.sessionId),
          fact: opened.fact,
        })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/persona/confirm') {
        const body = await readJson(req)
        if (typeof body.text !== 'string' || body.text.trim() === '')
          return send(res, 400, toolError('VALIDATION', 'text is required.'))
        const persona = engine.confirmPersona(body.text, typeof body.note === 'string' ? body.note : undefined)
        if (typeof body.sessionId === 'string' && body.sessionId !== '') {
          if (!engine.isBot(body.sessionId))
            return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can bind a persona.'))
          engine.bindPersona(body.sessionId, persona.id)
        }
        return send(res, 200, { ok: true, persona })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/memory') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        return send(res, 200, { ok: true, ...memoryView(engine, sessionId) })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/skills/register') {
        const body = await readJson(req)
        if (!engine.isBot(body.sessionId))
          return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can register a skill.'))
        const row = engine.registerSkillFromDisk(
          body.sessionId,
          body.scope === 'private' ? 'private' : 'public',
          body.skillId,
        )
        return send(res, 200, { ok: true, skill: row })
      }
      const hookMatch = /^\/session-foundations\/hooks\/([^/]+)$/.exec(path)
      if (req.method === 'POST' && hookMatch) {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const raw = await readRaw(req, 65536)
        const result = await runtime.acceptWebhook(hookMatch[1], raw, {
          timestamp: header(req, 'x-foundations-timestamp'),
          signature: header(req, 'x-foundations-signature'),
          eventId: header(req, 'x-foundations-event-id'),
        })
        return send(res, result.http, result.body)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/allow') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.allow(body.targetSessionId, body.senderSessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/deny') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.deny(body.targetSessionId, body.senderSessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/send') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        if (typeof body.senderSessionId !== 'string')
          return send(res, 400, toolError('VALIDATION', 'senderSessionId is required.'))
        const result = await runtime.send(body.senderSessionId, body)
        return send(res, result.ok ? 202 : 400, result)
      }
      if (req.method === 'GET' && path === '/session-foundations/api/deliveries') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, {
          ok: true,
          deliveries: runtime.listDeliveries(
            url.searchParams.get('sessionId') ?? '',
            url.searchParams.get('correlationId') ?? '',
          ),
        })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/timers') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(
          res,
          200,
          runtime.addSchedule({
            sessionId: body.sessionId,
            kind: body.kind,
            cron: body.cron,
            runAt: body.runAt,
            timezone: body.timezone,
            note: body.note,
          }),
        )
      }
      if (req.method === 'GET' && path === '/session-foundations/api/timers') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, { ok: true, timers: runtime.listSchedules() })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/timers/flags') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        if (body.deleted === true) return send(res, 200, runtime.deleteSchedule(body.id))
        return send(res, 200, runtime.setScheduleEnabled(body.id, body.enabled !== false))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/webhooks') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        const created = runtime.registerWebhook(body.targetSessionId)
        if (created.ok === false) return send(res, 400, created)
        return send(res, 200, { ok: true, hook: created.hook })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/webhooks') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, { ok: true, webhooks: runtime.listWebhooks() })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/webhooks/revoke') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.revokeWebhook(body.id))
      }
      if (
        req.method === 'GET' &&
        (path === '/session-foundations/api/snapshot' ||
          path === '/session-foundations/api/snapshot/chunks' ||
          path === '/session-foundations/api/snapshot/range')
      ) {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        if (path === '/session-foundations/api/snapshot/chunks') {
          const hashes = url.searchParams.getAll('hash').filter(hash => hash !== '')
          const taken = sessionSnapshots.take(sessionId, hashes)
          if (!taken) return send(res, 409, toolError('STALE', 'Ask for the snapshot manifest again.'))
          return send(res, 200, taken)
        }
        const beforeSeq = readCount(url, 'beforeSeq')
        const fromSeq = readCount(url, 'fromSeq')
        const tailMessages = readCount(url, 'tailMessages')
        if (beforeSeq === false || fromSeq === false || tailMessages === false)
          return send(res, 400, toolError('VALIDATION', 'Sequence bounds must be non-negative integers.'))
        /** @type {unknown[]} */
        let events: unknown[] = []
        try {
          events = await sessionEvents(ctx, sessionId)
        } catch (error) {
          return send(
            res,
            503,
            toolError('UNAVAILABLE', error instanceof Error ? error.message : 'The session log is not readable.'),
          )
        }
        if (path === '/session-foundations/api/snapshot/range') {
          if (typeof fromSeq !== 'number') return send(res, 400, toolError('VALIDATION', 'fromSeq is required.'))
          return send(res, 200, { ok: true, sessionId, events: eventsWindow(events, fromSeq, beforeSeq) })
        }
        const tail = typeof tailMessages === 'number' && tailMessages > 0 ? Math.min(tailMessages, 80) : null
        const cut = typeof beforeSeq === 'number' ? beforeSeq : tail == null ? null : followTailStart(events, tail)
        const source = cut == null ? events : eventsBefore(events, cut)
        if (source.length === 0) {
          return send(res, 200, {
            ok: true,
            sessionId,
            epoch: '',
            totalSize: 0,
            hashes: [],
            count: 0,
            ...(cut == null ? {} : { beforeSeq: cut }),
          })
        }
        sessionSnapshots.publish(sessionId, source)
        const listed = sessionSnapshots.manifest(sessionId)
        if (listed.ok !== true) return send(res, 503, toolError('UNAVAILABLE', 'The session snapshot is not ready.'))
        return send(res, 200, cut == null ? listed : { ...listed, beforeSeq: cut })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/live') {
        const work = getWork()
        if (!work) return send(res, 503, toolError('UNAVAILABLE', 'The work host is not attached yet.'))
        return openPageLive(req, res, {
          workStamp: () => work.liveStamp(),
          workBoard: () => work.liveBoardAll(),
          loadDesk: () => loadPageDesk(req),
        })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/work/live') {
        const work = getWork()
        if (!work) return send(res, 503, toolError('UNAVAILABLE', 'The work host is not attached yet.'))
        return openWorkLive(req, res, url.searchParams.get('sessionId') ?? '', work)
      }
      if (path.startsWith('/session-foundations/api/work')) {
        const workBody = req.method === 'GET' ? {} : await readJson(req)
        const workHit = await handleWorkApi(req.method ?? 'GET', path, url, workBody, getWork())
        if (workHit) return send(res, workHit.status, workHit.body)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/skills/flags') {
        const body = await readJson(req)
        if (!engine.isBot(body.sessionId))
          return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can change a skill.'))
        const row = engine.setSkillFlags(body.sessionId, body.skillId, {
          enabled: body.enabled,
          revoked: body.revoked,
        })
        return send(res, 200, { ok: true, skill: row })
      }
      return send(res, 404, { ok: false, code: 'NOT_FOUND' })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STORE_FAILURE'
      return send(res, code === 'VALIDATION' || code === 'NOT_FOUND' || code === 'FORBIDDEN' ? 400 : 500, {
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  ctx.effect(() => {
    const disposeFoundations = webServer.register({
      kind: 'prefix',
      path: '/session-foundations',
      handler,
    })
    const disposeDesk = webServer.register({
      kind: 'prefix',
      path: '/dsh-bot',
      handler,
    })
    return () => {
      if (typeof disposeFoundations === 'function') disposeFoundations()
      if (typeof disposeDesk === 'function') disposeDesk()
    }
  })
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} sessionId
 */
export function status(engine: import('./engine.ts').Engine, sessionId: string) {
  if (sessionId === '') {
    const persona = engine.latestPersona()
    return { ok: true, persona, personaText: personaText(engine, persona) }
  }
  const binding = engine.binding(sessionId)
  const view = binding ? engine.currentView(sessionId) : null
  const persona = binding?.persona_version_id ? engine.persona(binding.persona_version_id) : null
  return {
    ok: true,
    kind: binding?.kind === 'bot' ? 'bot' : 'session',
    binding,
    view,
    persona,
    personaText: personaText(engine, persona),
    skills: binding
      ? engine.store.db
          .prepare(
            'SELECT skill_id, scope, version, enabled, revoked, content_hash FROM skill_bindings WHERE session_id = ?',
          )
          .all(sessionId)
      : [],
    isolation: 'host-session-id',
    sandbox: false,
  }
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {{ content_hash: string } | null} persona
 */
function personaText(engine: import('./engine.ts').Engine, persona: { content_hash: string } | null) {
  if (!persona) return ''
  const bytes = engine.store.readBlob('persona', persona.content_hash)
  return bytes ? bytes.toString('utf8') : ''
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} sessionId
 */
export function memoryView(engine: import('./engine.ts').Engine, sessionId: string) {
  return {
    facts: engine.store.db
      .prepare('SELECT id, content, status, revision, priority FROM facts WHERE session_id = ? ORDER BY id')
      .all(sessionId),
    memories: engine.store.db
      .prepare('SELECT id, title, content, status, revision FROM memories WHERE session_id = ? ORDER BY id')
      .all(sessionId),
    state: engine.statePayload(sessionId),
  }
}

/**
 * A non-negative integer query, or null when the parameter is absent.
 * @param {URL} url
 * @param {string} name
 * @returns {number | null | false}
 */
function readCount(url: URL, name: string): number | null | false {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(raw)) return false
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) return false
  return value
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} req
 */
function reject(ctx: HostContext, req: import('node:http').IncomingMessage) {
  const connection = ctx.get?.('connection') ?? ctx.connection
  const rejection = connection?.requestRejection?.(req)
  if (rejection !== undefined) return rejection
  const remote = req.socket?.remoteAddress ?? ''
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return 403
  return 0
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  if (status === 0) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 */
function header(req: DeskRequest | import('node:http').IncomingMessage, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 */
function readRaw(req: import('node:http').IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: any[] = []
    let size = 0
    req.on('data', (chunk: any) => {
      size += chunk.length
      if (size > max) {
        rejectPromise(Object.assign(new Error('The body is too long.'), { code: 'VALIDATION' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

function readJson(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: any[] = []
    req.on('data', (chunk: any) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        rejectPromise(Object.assign(new Error('invalid json'), { code: 'VALIDATION', cause: error }))
      }
    })
    req.on('error', rejectPromise)
  })
}

/**
 * Call the host RPC on this same DSH process. The cookie is the browser session cookie.
 * This process does not read the launch token.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} endpoint
 * @param {Record<string, unknown>} args
 */
async function hostRpc(req: DeskRequest, endpoint: string, args: Record<string, unknown>) {
  const origin = localOrigin(req)
  const cookie = header(req, 'cookie') ?? ''
  if (origin === '' || cookie === '') {
    return {
      status: 503,
      body: {
        result: {
          ok: false,
          error: { code: 'primary_unready', message: 'This process has not issued a session cookie yet.' },
        },
      },
    }
  }
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie,
      origin,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: { args },
    }),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const result = parsed?.result ?? { ok: false, error: { code: 'bad-response', message: `HTTP ${response.status}` } }
  return { status: response.status, body: { result } }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function hostUsage(req: DeskRequest) {
  const origin = localOrigin(req)
  const cookie = header(req, 'cookie') ?? ''
  if (origin === '' || cookie === '')
    return { connected: false, code: 'primary_unready', error: 'This process has not issued a session cookie yet.' }
  let response
  try {
    response = await fetch(`${origin}/ollama-usage/api/summary`, {
      headers: { accept: 'application/json', cookie, origin },
    })
  } catch {
    return { connected: false, code: 'primary_down', error: 'The runtime could not be reached.' }
  }
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (response.status === 404)
    return { connected: false, code: 'usage_not_installed', error: 'The usage plugin is not installed.' }
  if (!body || body.ok !== true) {
    return {
      connected: false,
      code: 'usage_unconfigured',
      status: response.status,
      error: typeof body?.error === 'string' ? body.error : 'The usage upstream is unavailable.',
    }
  }
  return { connected: true, summary: body }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function localOrigin(req: DeskRequest) {
  const port = req.socket?.localPort
  if (!port) return ''
  const address = req.socket?.localAddress ?? ''
  const host = address === '::1' ? '[::1]' : '127.0.0.1'
  return `http://${host}:${port}`
}

const DESK_DIR = fileURLToPath(new URL('../public/', import.meta.url))
const DESK_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
])

/** Workbench files built into public/. API routes are handled before this. */
function serveDesk(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  pathname: string,
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const rel = pathname === '/dsh-bot' ? 'index.html' : pathname.slice('/dsh-bot/'.length)
  let decoded = rel
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return false
  }
  if (decoded === '' || decoded.includes('\0') || decoded.includes('..')) return false
  const root = resolve(DESK_DIR)
  const file = resolve(root, decoded)
  if (file !== root && !file.startsWith(root + sep)) return false
  let stat
  try {
    stat = statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  res.writeHead(200, {
    'content-type': DESK_TYPES.get(extname(file)) ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
  return true
}
