import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStore, pidAlive } from './store.ts'
import { createEngine } from './engine.ts'
import { renderPeers, renderSession, renderTickets } from './context.ts'
import { toolDefinitions } from './tools.ts'
import { createTriggers } from './triggers.ts'
import { followupDurable, liveAgent, logHasMessage, removePending, sessionEvents } from './inbox.ts'
import { toolError } from './errors.ts'
import { publishRuntime, publishWorkRuntime, runtimeFor } from './runtime-registry.ts'
import { type HostContext, type PluginHost } from './host.ts'
import { childCreateOptions, type WorkBudget } from './work-admit.ts'
import { ensureWorkerFilePreset, WORKER_FILE_PRESET, workerFileSetup } from './work-child.ts'
import { createWorkRuntime } from './work-worker.ts'
import { workToolDefinitions } from './work-tools.ts'

export const name = 'session-foundations'
// Cordis throws if a plugin reads a service it did not inject. Crash recovery reads the session log through this one.
export const inject = ['systemPrompt', 'tools', 'sessions', 'agents', 'agentPresets', 'sessionPersistence']

/**
 * @param {import('./host.ts').PluginHost} ctx
 * @param {{ dataDir?: string, contextWindow?: number, traceEvents?: boolean, timerTickMs?: number }} [config]
 */
export function apply(
  ctx: PluginHost,
  config: {
    dataDir?: string
    contextWindow?: number
    traceEvents?: boolean
    timerTickMs?: number
    work?: Partial<WorkBudget>
  } = {},
) {
  const dataDir = config.dataDir ?? (ctx.profileContext?.dir ? join(ctx.profileContext.dir, 'session-foundations') : '')
  if (dataDir === '') throw new Error('session-foundations: pass dataDir or launch with dsh profileContext')
  const store = openStore(dataDir)
  const engine = createEngine(store)
  const recovery = engine.recover()
  const ownerFile = join(dataDir, 'owner.json')
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
  ctx.effect(() => () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
      if (owner.pid === process.pid) rmSync(ownerFile, { force: true })
    } catch {
      /* already gone */
    }
    try {
      store.close()
    } catch {
      /* closed */
    }
  })

  /** @type {ReturnType<typeof createTriggers> | null} */
  let triggers: ReturnType<typeof createTriggers> | null = null
  const trace = config.traceEvents === true ? join(dataDir, 'observed-events.jsonl') : ''
  if (trace) mkdirSync(dataDir, { recursive: true })
  const logEvent = (sessionId: string, type: string, extra: Record<string, unknown>) => {
    if (!trace) return
    appendFileSync(trace, `${JSON.stringify({ at: new Date().toISOString(), sessionId, type, ...extra })}\n`)
  }

  const window = config.contextWindow
  const rendered = new Map<string, ReturnType<typeof renderSession>>()
  const render = (sessionId: string) => {
    const view = renderSession(engine, sessionId, window)
    rendered.set(sessionId, view)
    return view
  }
  const textFor = (sessionId: string, name: string) => {
    if (!sessionId || !engine.isBot(sessionId)) return ''
    const view = rendered.get(sessionId) ?? render(sessionId)
    const texts: Record<string, string> = view.texts
    return texts[name] ?? ''
  }
  const sessionFrom = (assemble: { agent?: { id?: string } } | null | undefined) => assemble?.agent?.id

  const section = (name: string, order: number, pick: (id: string) => string) => {
    ctx.systemPrompt.section({
      name,
      order,
      interpolate: false,
      text: (assemble: { agent?: { id?: string } } | null | undefined) => pick(sessionFrom(assemble) ?? ''),
    })
  }
  const context = (name: string, order: number, required: boolean, pick: (id: string) => string) => {
    ctx.systemPrompt.context({
      name,
      order,
      required,
      interpolate: false,
      text: (assemble: { agent?: { id?: string } } | null | undefined) => {
        const sessionId = sessionFrom(assemble)
        if (!sessionId || !engine.isBot(sessionId)) return ''
        if (!rendered.has(sessionId)) render(sessionId)
        return pick(sessionId)
      },
    })
  }

  section('foundations:chat', 39, id => (id ? textFor(id, 'foundations:chat') : ''))
  section('foundations:soul', 40, id => (id ? textFor(id, 'foundations:soul') : ''))
  section('foundations:rules', 41, id => (id ? textFor(id, 'foundations:rules') : ''))
  section('foundations:peers', 42, id => (id && engine.isBot(id) ? renderPeers(engine.listBots(), id) : ''))
  context('foundations:revocation', 900, true, id => textFor(id, 'foundations:revocation'))
  context('foundations:user', 1000, false, id => textFor(id, 'foundations:user'))
  context('foundations:facts', 1010, false, id => textFor(id, 'foundations:facts'))
  context('foundations:state', 1020, false, id => textFor(id, 'foundations:state'))
  context('foundations:skills', 1030, false, id => textFor(id, 'foundations:skills'))
  /** @type {ReturnType<typeof createWorkRuntime> | null} */
  let work: ReturnType<typeof createWorkRuntime> | null = null
  section('foundations:tickets', 43, id => (id && work && engine.isBot(id) ? renderTickets(work.summaries(id)) : ''))

  const revisionOf = (sessionId: string) =>
    rendered.get(sessionId)?.viewRevision ?? engine.currentView(sessionId)?.revision ?? 0
  for (const definition of toolDefinitions(engine, () => 0)) {
    const original = definition.execute
    definition.execute = async (args, exec) => {
      const sessionId = exec?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '')
        return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
      if (!engine.isBot(sessionId))
        return toolError('FORBIDDEN', 'This session is not a bot, so persona and memory do not apply here.')
      const result = await original(args, exec)
      if (result && result.ok === true && (result.viewRevisionFrozen === 0 || result.viewRevisionFrozen == null)) {
        result.viewRevisionFrozen = typeof sessionId === 'string' ? revisionOf(sessionId) : 0
      }
      return result
    }
    ctx.tools.register(definition)
  }

  ctx.on(
    'session/event',
    (
      session: { id?: string; header?: { parentSession?: string | null; isSeeded?: boolean } } | null,
      event: {
        type?: string
        seq?: number
        data?: {
          id?: string
          turn?: number | null
          message?: { id?: string; source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }
          source?: { kind?: string }
          reason?: { kind?: string }
          content?: Array<{ type?: string; text?: string }>
        }
        surfaceOp?: { op?: string }
        sourceEventSeqs?: unknown[]
      } | null,
    ) => {
      if (session == null || event == null || typeof event.type !== 'string') return
      const sessionId = session.id
      if (typeof sessionId !== 'string') return
      const bot = engine.isBot(sessionId)
      const worker = work?.isWorkerSession(sessionId) === true
      if (!bot && !worker) return
      if (work) work.observeSession(sessionId, event)
      if (!bot) return
      engine.ensureSession(sessionId, {
        parentSessionId: session.header?.parentSession ?? null,
        seeded: session.header?.isSeeded === true,
      })
      if (typeof event.seq === 'number') engine.noteWatermark(sessionId, String(event.seq))
      logEvent(sessionId, event.type, { seq: event.seq ?? null })
      if (event.type === 'turn/start') {
        rendered.delete(sessionId)
        engine.openViews.delete(sessionId)
      }
      if (event.type === 'compaction/end' || event.type === 'compaction/start' || event.type === 'compaction/summary') {
        if (event.type === 'compaction/end') {
          rendered.delete(sessionId)
          engine.bumpEpoch(sessionId, 'needs_reinject')
        }
      }
      if (event.type === 'user/message') {
        const text = messageText(event)
        const messageId = event.data?.id ?? event.data?.message?.id
        if (triggers && typeof messageId === 'string')
          triggers.observeUserMessage(sessionId, messageId, event.data?.turn ?? null)
        const source = event.data?.message?.source ?? event.data?.source
        if (source?.kind === 'runtime-context' && typeof text === 'string' && text.includes('[foundations:')) {
          engine.noteSurface(sessionId, typeof event.seq === 'number' ? event.seq : null)
        }
        const op = event.surfaceOp
        if (op && typeof op === 'object' && op.op === 'replace' && Array.isArray(event.sourceEventSeqs)) {
          engine.noteRemoval(
            sessionId,
            event.sourceEventSeqs.filter((seq): seq is number => typeof seq === 'number'),
          )
        }
      }
      if (triggers && event.type === 'turn/end') {
        const reason = event.data?.reason
        triggers.observeTurnEnd(
          sessionId,
          event.data?.turn ?? null,
          reason && typeof reason === 'object' ? (reason.kind ?? '') : '',
        )
      }
    },
  )

  ctx.on('agent/created', (payload: { agent?: { id?: string } } | null) => {
    const agent = payload?.agent
    if (!agent?.id || !engine.isBot(agent.id)) return
    let session = null
    try {
      session = ctx.sessions.get(agent.id)
    } catch {
      session = null
    }
    engine.ensureSession(agent.id, {
      parentSessionId: session?.header?.parentSession ?? null,
      seeded: session?.header?.isSeeded === true,
    })
  })

  triggers = ctx.agents ? startTriggers(ctx, store, engine) : null
  work = ctx.agents ? startWork(ctx, store, engine, config) : null
  if (triggers) {
    for (const definition of triggerTools(triggers, engine)) ctx.tools.register(definition)
  }
  if (work) {
    for (const definition of workToolDefinitions(work, engine)) ctx.tools.register(definition)
  }
  if (triggers || work) {
    const timer = setInterval(() => {
      triggers?.tick().catch(() => {})
      work?.tick().catch(() => {})
    }, config.timerTickMs ?? 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
    triggers?.tick().catch(() => {})
    work?.tick().catch(() => {})
  }

  ctx.logger?.info?.(
    'session-foundations: ready dir=%s bindings=%s promoted=%s',
    dataDir,
    recovery.bindings,
    recovery.promoted.length,
  )
}

/**
 * @param {import('./host.ts').PluginHost} ctx
 * @param {import('./src/store.js').Store} store
 * @param {import('./src/engine.js').Engine} engine
 */
function startTriggers(ctx: PluginHost, store: import('./store.ts').Store, engine: import('./engine.ts').Engine) {
  const triggers = createTriggers(store, {
    secretDir: store.root,
    push: (sessionId: string, messageId: string, text: string) => followupDurable(ctx, sessionId, messageId, text),
    logHas: (sessionId: string, messageId: string) => logHasDurable(ctx, sessionId, messageId),
    removePending: (sessionId: string, messageId: string) => removePending(ctx, sessionId, messageId),
  })
  publishRuntime(store.root, triggers)
  ctx.effect(() => () => {
    if (runtimeFor(store.root) === triggers) publishRuntime(store.root, null)
  })
  ctx.on(
    'agent/inbox/claimed',
    (payload: { agent?: { id?: string }; message?: { id?: string }; turn?: number | null } | null) => {
      if (payload == null) return
      const sessionId = payload.agent?.id
      const messageId = payload.message?.id
      if (typeof sessionId === 'string' && typeof messageId === 'string')
        triggers.observeClaimed(sessionId, messageId, payload.turn ?? null)
    },
  )
  ctx.on('agent/inbox/discarded', (payload: { agent?: { id?: string }; message?: { id?: string } } | null) => {
    if (payload == null) return
    const sessionId = payload.agent?.id
    const messageId = payload.message?.id
    if (typeof sessionId === 'string' && typeof messageId === 'string') triggers.observeDiscarded(sessionId, messageId)
  })
  return triggers
}

/**
 * Bot dual-loop. Ordinary sessions never enter this runtime's tools.
 * Child agents are created without parentAgent so the main handle does not dispose them.
 * @param {import('./host.ts').PluginHost} ctx
 * @param {import('./src/store.js').Store} store
 * @param {import('./src/engine.js').Engine} engine
 * @param {{ work?: Partial<import('./src/work-admit.js').DEFAULT_WORK_BUDGET> }} config
 */
function startWork(
  ctx: PluginHost,
  store: import('./store.ts').Store,
  engine: import('./engine.ts').Engine,
  config: {
    dataDir?: string
    contextWindow?: number
    traceEvents?: boolean
    timerTickMs?: number
    work?: Partial<WorkBudget>
  },
) {
  /** @type {Map<string, { dispose?: () => Promise<void> }>} */
  const workerHandles: Map<string, { dispose?: () => Promise<void> }> = new Map()
  const filePreset = ensureWorkerFilePreset(ctx)
  const work = createWorkRuntime(store, engine, {
    budget: config.work ?? {},
    createChild: async spec => {
      let cwd = ''
      let model = null
      try {
        const owner = ctx.agents?.get(spec.ownerSessionId)
        cwd = owner?.session?.header?.cwd ?? ctx.sessions?.get(spec.ownerSessionId)?.header?.cwd ?? ''
        model = owner?.model?.current?.() ?? null
      } catch {
        cwd = ''
        model = null
      }
      if (!model?.provider || !model?.model) {
        try {
          model = ctx.agentDefaultModel?.currentSelection?.() ?? null
        } catch {
          model = null
        }
      }
      const cap = Number(process.env.WORK_EVAL_MAX_OUTPUT_TOKENS)
      const options = childCreateOptions(spec.sessionId, cwd, model, cap)
      const presetId = await filePreset
      if (presetId) {
        options.meta = { ...(options.meta ?? {}), agentPreset: WORKER_FILE_PRESET }
        options.setup = workerFileSetup(ctx, WORKER_FILE_PRESET)
      }
      const handle = await ctx.agents.create(options)
      workerHandles.set(spec.sessionId, handle)
      return spec.sessionId
    },
    push: (sessionId, messageId, text) => followupDurable(ctx, sessionId, messageId, text),
    logHas: (sessionId, messageId) => logHasDurable(ctx, sessionId, messageId),
    remove: (sessionId, messageId) => removePending(ctx, sessionId, messageId),
    pendingIds: async sessionId => {
      const agent = liveAgent(ctx, sessionId)
      if (!agent) return []
      const list = agent.inbox?.nextTurn
      if (!Array.isArray(list)) return null
      return list.map(message => message?.id).filter(id => typeof id === 'string')
    },
    cancel: async (sessionId, options) => {
      const agent = liveAgent(ctx, sessionId)
      if (!agent) return
      agent.cancel({ kind: 'user' }, { keepInbox: options.keepInbox === true })
    },
    snapshot: async sessionId => {
      try {
        return await sessionEvents(ctx, sessionId)
      } catch {
        return []
      }
    },
  })
  publishWorkRuntime(store.root, work)
  ctx.effect(() => () => {
    publishWorkRuntime(store.root, null)
    workerHandles.clear()
  })
  ctx.on(
    'agent/inbox/claimed',
    (payload: { agent?: { id?: string }; message?: { id?: string }; turn?: number | null } | null) => {
      if (payload == null) return
      const sessionId = payload.agent?.id
      const messageId = payload.message?.id
      if (typeof sessionId === 'string' && typeof messageId === 'string')
        work.observeClaimed(sessionId, messageId, payload.turn ?? null)
    },
  )
  return work
}

/**
 * @param {ReturnType<typeof createTriggers>} triggers
 * @param {import('./src/engine.js').Engine} engine
 */
function triggerTools(triggers: ReturnType<typeof createTriggers>, engine: import('./engine.ts').Engine) {
  const isBot = (sessionId: string) => engine.isBot(sessionId)
  return [
    triggerTool(
      'foundations_send',
      'Send an explicit message to another bot. Bots may message each other by default. Use the sessionId at the end of the other-bot roster in the system prompt, or the id in parentheses after @Name (sessionId) in a user message, as targetSessionId. This does not share persona, memory, or skills. An explicit refusal returns FORBIDDEN.',
      {
        type: 'object',
        properties: {
          targetSessionId: { type: 'string' },
          text: { type: 'string' },
          idempotencyKey: { type: 'string' },
          correlationId: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the sender.' },
          hop: { type: 'integer', description: 'Ignored. The host computes the hop count.' },
        },
        required: ['targetSessionId', 'text', 'idempotencyKey'],
      },
      (args, hostId) => triggers.send(hostId, args),
      isBot,
    ),
    triggerTool(
      'foundations_reply',
      'Reply to a correlated message sent to this session. The target comes from the ledger, not from another id in the arguments.',
      {
        type: 'object',
        properties: {
          correlationId: { type: 'string' },
          text: { type: 'string' },
          idempotencyKey: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the sender.' },
          targetSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['correlationId', 'text', 'idempotencyKey'],
      },
      (args, hostId) => triggers.reply(hostId, args),
      isBot,
    ),
  ]
}

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} parameters
 * @param {(args: Record<string, unknown>, hostId: string) => Promise<unknown>} run
 * @param {(sessionId: string) => boolean} isBot
 */
function triggerTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, hostId: string) => Promise<unknown>,
  isBot: (sessionId: string) => boolean,
) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          message: { type: 'string' },
          status: { type: 'string' },
          deliveryId: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args: Record<string, unknown> | null, exec: { agent?: { id?: string } } | null) {
      const hostId = exec?.agent?.id
      if (typeof hostId !== 'string' || hostId === '')
        return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
      if (!isBot(hostId))
        return toolError('FORBIDDEN', 'This session is not a bot, so cross-session messages do not apply here.')
      return run(args ?? {}, hostId)
    },
  }
}

/**
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 * @param {string} messageId
 */
async function logHasDurable(ctx: HostContext, sessionId: string, messageId: string) {
  const events = await sessionEvents(ctx, sessionId)
  return logHasMessage({ snapshotEvents: () => events }, messageId)
}

/**
 * @param {{ data?: { message?: { content?: Array<{ type?: string, text?: string }> }, content?: Array<{ type?: string, text?: string }> } }} event
 */
function messageText(event: {
  data?: {
    message?: { content?: Array<{ type?: string; text?: string }> }
    content?: Array<{ type?: string; text?: string }>
  } | null
}) {
  const content = event.data?.message?.content ?? event.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

export { pidAlive }
