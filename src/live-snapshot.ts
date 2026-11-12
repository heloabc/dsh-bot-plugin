import { planChunks } from './cdc.ts'
import { stableStringify } from './log/canonical.ts'

/**
 * Session history is one canonical JSON array of the host event log.
 * FastCDC is only for that blob, and only when a session is opened.
 * The live tail is the events themselves, not these chunks.
 */

const PLAN_LIMIT = 8

/**
 * Sorted-key JSON, so the same log cuts into the same chunks.
 * Array order is the host order.
 */
export { stableStringify } from './log/canonical.ts'

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(stableStringify(value), 'utf8')
}

export function eventLogBytes(events: unknown[]): Buffer {
  return canonicalBytes(Array.isArray(events) ? events : [])
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

function eventSeq(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' ? seq : undefined
}

/**
 * First seq of the follow opening page for this message budget.
 * Same rule as the host history page: count append-origin user and assistant messages from the end.
 */
export function followTailStart(events: unknown[], maxMessages: number): number {
  const list = Array.isArray(events) ? events : []
  let count = 0
  let cut = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (!event || typeof event !== 'object') continue
    const record = event as { type?: unknown; surfaceOp?: unknown; seq?: unknown; sourceEventSeqs?: unknown }
    if (typeof record.type !== 'string' || !MESSAGE_TYPES.has(record.type) || record.surfaceOp !== 'append') continue
    count += 1
    let groupStart = typeof record.seq === 'number' ? record.seq : index
    if (Array.isArray(record.sourceEventSeqs)) {
      for (const source of record.sourceEventSeqs) {
        if (typeof source === 'number' && source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  return cut
}

/**
 * The prefix `session/follow` does not send.
 * `beforeSeq` is the first seq of the follow opening page. That page is a suffix, so everything before it belongs to CDC.
 */
export function eventsBefore<T>(events: readonly T[], beforeSeq: number): T[] {
  const list = Array.isArray(events) ? events : []
  const cut = list.findIndex(event => {
    const seq = eventSeq(event)
    return seq !== undefined && seq >= beforeSeq
  })
  return cut < 0 ? list.slice() : list.slice(0, cut)
}

/**
 * Events in `[fromSeq, beforeSeq)`. A missing `beforeSeq` runs through the end.
 */
export function eventsWindow<T>(events: readonly T[], fromSeq: number, beforeSeq: number | null = null): T[] {
  const list = Array.isArray(events) ? events : []
  const start = list.findIndex(event => {
    const seq = eventSeq(event)
    return seq !== undefined && seq >= fromSeq
  })
  if (start < 0) return []
  if (beforeSeq == null) return list.slice(start)
  const end = list.findIndex((event, index) => {
    if (index < start) return false
    const seq = eventSeq(event)
    return seq !== undefined && seq >= beforeSeq
  })
  return end < 0 ? list.slice(start) : list.slice(start, end)
}

interface SessionPlan {
  epoch: string
  hashes: string[]
  totalSize: number
  chunks: Map<string, Buffer>
  count: number
}

export function createSessionSnapshots() {
  const plans = new Map<string, SessionPlan>()
  const order: string[] = []

  function publish(sessionId: string, events: unknown[]): SessionPlan {
    const list = Array.isArray(events) ? events : []
    const plan = { ...planChunks(eventLogBytes(list)), count: list.length }
    const previous = plans.get(sessionId)
    if (previous && previous.epoch === plan.epoch) return previous
    plans.set(sessionId, plan)
    const index = order.indexOf(sessionId)
    if (index >= 0) order.splice(index, 1)
    order.push(sessionId)
    while (order.length > PLAN_LIMIT) {
      const old = order.shift()
      if (old) plans.delete(old)
    }
    return plan
  }

  /** Manifest only. Chunk bodies stay on the chunk route. */
  function manifest(sessionId: string) {
    const plan = plans.get(sessionId)
    if (!plan) return { ok: false }
    return {
      ok: true,
      sessionId,
      epoch: plan.epoch,
      totalSize: plan.totalSize,
      hashes: plan.hashes,
      count: plan.count,
    }
  }

  function take(sessionId: string, hashes: readonly string[]) {
    const plan = plans.get(sessionId)
    if (!plan) return null
    const chunks: Record<string, string> = {}
    for (const hash of hashes) {
      if (chunks[hash]) continue
      const body = plan.chunks.get(hash)
      if (!body) return null
      chunks[hash] = body.toString('base64')
    }
    return { ok: true, sessionId, chunks }
  }

  return { publish, manifest, take }
}
