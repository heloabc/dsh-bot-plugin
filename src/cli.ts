#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openStore, pidAlive, restoreBackup } from './store.ts'
import { createEngine } from './engine.ts'
import { toolDefinitions } from './tools.ts'
import { createTriggers } from './triggers.ts'
import { createWorkRuntime } from './work-worker.ts'

/**
 * Admin-command usage. `program` is the command the operator typed, usually `dsh-bot`.
 * @param {string} [program]
 */
export function usage(program: string = 'dsh-bot') {
  return `usage:
  ${program} persona confirm --data-dir DIR --file SOUL.md [--session ID]
  ${program} persona show --data-dir DIR
  ${program} session bind --data-dir DIR --session ID [--persona ID]
  ${program} memory remember --data-dir DIR --session ID --content TEXT --key KEY [--target fact|memory] [--title TEXT] [--priority N]
  ${program} memory correct --data-dir DIR --session ID --id N --content TEXT --revision N --key KEY [--target fact|memory]
  ${program} memory forget --data-dir DIR --session ID --id N --revision N --key KEY [--target fact|memory]
  ${program} memory list --data-dir DIR --session ID
  ${program} skill register --data-dir DIR --session ID --id skill-id [--scope public|private]
  ${program} skill enable|disable|revoke --data-dir DIR --session ID --id skill-id
  ${program} skill list --data-dir DIR --session ID
  ${program} status --data-dir DIR [--session ID]
  ${program} message allow|deny --data-dir DIR --target ID --from ID
  ${program} message list --data-dir DIR [--session ID] [--correlation ID]
  ${program} message send --data-dir DIR --from ID --target ID --text TEXT --key KEY
  ${program} work dispatch --data-dir DIR --session ID --text TEXT [--key KEY]
  ${program} timer add --data-dir DIR --session ID (--at ISO | --cron EXPR) [--timezone Asia/Shanghai] [--note TEXT]
  ${program} timer list|pause|resume|delete --data-dir DIR [--id ID]
  ${program} webhook register --data-dir DIR --session ID
  ${program} webhook list|revoke --data-dir DIR [--id ID]
  ${program} backup --data-dir DIR [--to DIR]
  ${program} restore --data-dir DIR --from DIR`
}

/**
 * Run one admin command. Does not start DSH.
 * Sets `process.exitCode` and returns it.
 * @param {string[]} argv
 * @param {{ program?: string }} [options]
 */
export async function run(argv: string[], options: { program?: string } = {}) {
  const program = options.program || 'dsh-bot'
  const command = argv[0]
  const action = argv[1] && !argv[1].startsWith('--') ? argv[1] : ''
  const flags = flagsOf(action ? argv.slice(2) : argv.slice(1))

  /** @type {import('./store.js').Store | null} */
  let triggerStore: import('./store.ts').Store | null = null

  /**
   * Operator entry. `--session` is the session the operator is managing.
   * Model tools ignore a different id and use the host agent id instead.
   * @param {import('./engine.js').Engine} engine
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async function runTool(engine: import('./engine.ts').Engine, name: string, args: Record<string, unknown>) {
    const sessionId = required(flags, 'session')
    const tools = Object.fromEntries(toolDefinitions(engine, () => 0).map(item => [item.name, item]))
    const result = await tools[name].execute(args, { agent: { id: sessionId }, signal: AbortSignal.timeout(10000) })
    console.log(JSON.stringify(result, null, 2))
    engine.store.close()
    if (!result || result.ok !== true) process.exitCode = 1
  }

  function dataDir() {
    const dir = flags['data-dir'] ?? process.env.SESSION_FOUNDATIONS_DIR ?? ''
    if (dir === '') throw new Error('pass --data-dir or SESSION_FOUNDATIONS_DIR')
    return dir
  }

  function openEngine() {
    return createEngine(openStore(dataDir()))
  }

  function openTriggers() {
    triggerStore = openStore(dataDir())
    return createTriggers(triggerStore, {
      resident: false,
      push: async () => ({ ok: false, error: 'cli-does-not-deliver' }),
    })
  }

  function triggersClose() {
    triggerStore?.close()
    triggerStore = null
  }

  try {
    if (command === 'persona' && action === 'confirm') {
      const engine = openEngine()
      const text = flags.file ? readFileSync(flags.file, 'utf8') : flags.text
      if (!text) throw new Error('pass --file or --text')
      const persona = engine.confirmPersona(text, flags.note)
      if (flags.session) engine.bindPersona(flags.session, persona.id)
      console.log(JSON.stringify({ ok: true, persona }, null, 2))
      engine.store.close()
    } else if (command === 'persona' && action === 'show') {
      const engine = openEngine()
      const persona = engine.latestPersona()
      const body = persona ? engine.store.readBlob('persona', persona.content_hash)?.toString('utf8') : ''
      console.log(JSON.stringify({ ok: true, persona, body }, null, 2))
      engine.store.close()
    } else if (command === 'session' && action === 'bind') {
      const engine = openEngine()
      const binding = engine.bindPersona(
        required(flags, 'session'),
        flags.persona ? Number(flags.persona) : (engine.latestPersona()?.id ?? null),
      )
      console.log(JSON.stringify({ ok: true, binding }, null, 2))
      engine.store.close()
    } else if (command === 'memory' && action === 'remember') {
      const engine = openEngine()
      await runTool(engine, 'foundations_remember', {
        target: flags.target === 'memory' ? 'memory' : 'fact',
        content: required(flags, 'content'),
        idempotencyKey: required(flags, 'key'),
        ...(flags.title ? { title: flags.title } : {}),
        ...(flags.priority ? { priority: Number(flags.priority) } : {}),
      })
    } else if (command === 'memory' && action === 'correct') {
      const engine = openEngine()
      await runTool(engine, 'foundations_correct', {
        target: flags.target === 'memory' ? 'memory' : 'fact',
        id: Number(required(flags, 'id')),
        content: required(flags, 'content'),
        expectedRevision: Number(required(flags, 'revision')),
        idempotencyKey: required(flags, 'key'),
        ...(flags.title ? { title: flags.title } : {}),
      })
    } else if (command === 'memory' && action === 'forget') {
      const engine = openEngine()
      await runTool(engine, 'foundations_forget', {
        target: flags.target === 'memory' ? 'memory' : 'fact',
        id: Number(required(flags, 'id')),
        expectedRevision: Number(required(flags, 'revision')),
        idempotencyKey: required(flags, 'key'),
      })
    } else if (command === 'memory' && action === 'list') {
      const engine = openEngine()
      const sessionId = required(flags, 'session')
      engine.ensureSession(sessionId)
      console.log(
        JSON.stringify(
          {
            facts: engine.store.db
              .prepare('SELECT id, status, revision, priority, content FROM facts WHERE session_id = ? ORDER BY id')
              .all(sessionId),
            memories: engine.store.db
              .prepare('SELECT id, status, revision, title, content FROM memories WHERE session_id = ? ORDER BY id')
              .all(sessionId),
            state: engine.statePayload(sessionId),
          },
          null,
          2,
        ),
      )
      engine.store.close()
    } else if (command === 'skill' && action === 'register') {
      const engine = openEngine()
      const row = engine.registerSkillFromDisk(
        required(flags, 'session'),
        flags.scope === 'private' ? 'private' : 'public',
        required(flags, 'id'),
      )
      console.log(JSON.stringify({ ok: true, skill: row }, null, 2))
      engine.store.close()
    } else if (command === 'skill' && (action === 'enable' || action === 'disable' || action === 'revoke')) {
      const engine = openEngine()
      const row = engine.setSkillFlags(required(flags, 'session'), required(flags, 'id'), {
        enabled: action === 'disable' ? false : action === 'enable' ? true : undefined,
        revoked: action === 'revoke' ? true : undefined,
      })
      console.log(JSON.stringify({ ok: true, skill: row }, null, 2))
      engine.store.close()
    } else if (command === 'skill' && action === 'list') {
      const engine = openEngine()
      const rows = engine.store.db
        .prepare('SELECT * FROM skill_bindings WHERE session_id = ? ORDER BY skill_id')
        .all(required(flags, 'session'))
      console.log(JSON.stringify({ ok: true, skills: rows }, null, 2))
      engine.store.close()
    } else if (command === 'message' && action === 'allow') {
      const triggers = openTriggers()
      console.log(JSON.stringify(triggers.allow(required(flags, 'target'), required(flags, 'from')), null, 2))
      triggersClose()
    } else if (command === 'message' && action === 'deny') {
      const triggers = openTriggers()
      console.log(JSON.stringify(triggers.deny(required(flags, 'target'), required(flags, 'from')), null, 2))
      triggersClose()
    } else if (command === 'message' && action === 'list') {
      const triggers = openTriggers()
      console.log(
        JSON.stringify(
          {
            ok: true,
            acl: triggers.listAcl(),
            deliveries: triggers.listDeliveries(flags.session ?? '', flags.correlation ?? ''),
          },
          null,
          2,
        ),
      )
      triggersClose()
    } else if (command === 'work' && action === 'dispatch') {
      const engine = openEngine()
      const sessionId = required(flags, 'session')
      if (!engine.isBot(sessionId)) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              code: 'FORBIDDEN',
              message: 'An ordinary session stays on one loop and cannot dispatch work.',
            },
            null,
            2,
          ),
        )
        engine.store.close()
        process.exitCode = 1
      } else {
        const work = createWorkRuntime(engine.store, engine, {
          resident: false,
          push: async () => ({ ok: false, ambiguous: true }),
        })
        const result = await work.dispatch(sessionId, {
          briefing: required(flags, 'text'),
          idempotencyKey: flags.key,
        })
        console.log(JSON.stringify(result, null, 2))
        engine.store.close()
        if (result.ok !== true) process.exitCode = 1
      }
    } else if (command === 'message' && action === 'send') {
      const triggers = openTriggers()
      const result = await triggers.send(required(flags, 'from'), {
        targetSessionId: required(flags, 'target'),
        text: required(flags, 'text'),
        idempotencyKey: required(flags, 'key'),
      })
      console.log(
        JSON.stringify(
          {
            ...result,
            ...('status' in result && result.status === 'intent'
              ? {
                  queued: false,
                  note: 'Only the intent was written. A resident DSH host reconciles it and then followup reaches the native inbox. This process will not execute after it exits.',
                }
              : {}),
          },
          null,
          2,
        ),
      )
      triggersClose()
      if (!result.ok) process.exitCode = 1
    } else if (
      command === 'timer' &&
      (action === 'add' || action === 'list' || action === 'pause' || action === 'resume' || action === 'delete')
    ) {
      const triggers = openTriggers()
      if (action === 'add') {
        const result = triggers.addSchedule({
          sessionId: required(flags, 'session'),
          kind: flags.cron ? 'cron' : 'one-shot',
          cron: flags.cron,
          runAt: flags.at,
          timezone: flags.timezone,
          note: flags.note ?? '',
        })
        console.log(
          JSON.stringify(
            {
              ...result,
              note: 'The definition is in SQLite. Only a resident host tick performs the followup. The CLI does not deliver it.',
            },
            null,
            2,
          ),
        )
        if (!result.ok) process.exitCode = 1
      } else if (action === 'list') console.log(JSON.stringify({ ok: true, timers: triggers.listSchedules() }, null, 2))
      else if (action === 'pause')
        console.log(JSON.stringify(triggers.setScheduleEnabled(required(flags, 'id'), false), null, 2))
      else if (action === 'resume')
        console.log(JSON.stringify(triggers.setScheduleEnabled(required(flags, 'id'), true), null, 2))
      else console.log(JSON.stringify(triggers.deleteSchedule(required(flags, 'id')), null, 2))
      triggersClose()
    } else if (command === 'webhook' && (action === 'register' || action === 'revoke' || action === 'list')) {
      const triggers = openTriggers()
      if (action === 'register') {
        const result = triggers.registerWebhook(required(flags, 'session'))
        console.log(JSON.stringify(result.ok ? { ok: true, hook: result.hook } : result, null, 2))
        if (!result.ok) process.exitCode = 1
      } else if (action === 'revoke')
        console.log(JSON.stringify(triggers.revokeWebhook(required(flags, 'id')), null, 2))
      else console.log(JSON.stringify({ ok: true, webhooks: triggers.listWebhooks() }, null, 2))
      triggersClose()
    } else if (command === 'status') {
      const engine = openEngine()
      const sessionId = flags.session ?? ''
      const binding = sessionId ? engine.binding(sessionId) : null
      console.log(
        JSON.stringify(
          {
            ok: true,
            dataDir: dataDir(),
            persona: engine.latestPersona(),
            binding,
            view: binding ? engine.currentView(sessionId) : null,
            sandbox: false,
          },
          null,
          2,
        ),
      )
      engine.store.close()
    } else if (command === 'backup') {
      const engine = openEngine()
      const dest = flags.to ?? join(dataDir(), 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
      const manifest = await engine.store.backupTo(dest)
      console.log(JSON.stringify({ ok: true, dest, manifest }, null, 2))
      engine.store.close()
    } else if (command === 'restore') {
      const root = dataDir()
      const owner = readOwner(root)
      await restoreBackup(root, required(flags, 'from'), owner)
      console.log(JSON.stringify({ ok: true, dataDir: root, from: flags.from }, null, 2))
    } else {
      console.error(usage(program))
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
  return process.exitCode ?? 0
}

/**
 * @param {Record<string, string>} bag
 * @param {string} name
 */
function required(bag: Record<string, string>, name: string) {
  const value = bag[name]
  if (!value) throw new Error(`missing --${name}`)
  return value
}

/**
 * @param {string[]} argv
 */
function flagsOf(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value == null || value.startsWith('--')) out[key] = 'true'
    else {
      out[key] = value
      i += 1
    }
  }
  return out
}

/**
 * @param {string} root
 */
function readOwner(root: string) {
  try {
    const owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8'))
    return pidAlive(owner.pid) ? owner.pid : null
  } catch {
    return null
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await run(process.argv.slice(2))
}
