import { eventNdjson } from './canonical.ts'
import { planEventChunks, sha256Hex, type EventChunk, type EventChunkPlan } from './plan.ts'
import type { LogEvent, LogSource } from './source.ts'

export const RANGE_PAGE_LIMIT = 500
export const LOG_FORMAT = 'ndjson-v1' as const

type Plan = EventChunkPlan & { sessionId: string }

export type Manifest = EventChunkPlan & { sessionId: string }

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function createLogSnapshotService(source: LogSource) {
  const plans = new Map<string, Plan>()
  const inflight = new Map<string, Promise<Buffer>>()

  async function planOf(sessionId: string, throughSeq: number | undefined): Promise<Plan> {
    const head = await source.head(sessionId)
    const pin = throughSeq == null ? head : throughSeq
    if (!Number.isInteger(pin) || pin < -1)
      throw new HttpError(400, 'VALIDATION', 'throughSeq must be an integer >= -1.')
    if (pin > head) throw new HttpError(409, 'STALE', 'throughSeq is past the current log head.')
    const cached = plans.get(sessionId)
    if (cached && cached.throughSeq === pin) return cached
    const { events } = await source.read(sessionId, -1, pin)
    const planned = { sessionId, ...planEventChunks(events), throughSeq: pin, count: events.length }
    if (pin === -1) planned.throughSeq = -1
    plans.set(sessionId, planned)
    return planned
  }

  async function chunkBytes(sessionId: string, fromSeq: number, toSeq: number, hash: string): Promise<Buffer> {
    const key = `${sessionId}:${fromSeq}:${toSeq}:${hash}`
    const existing = inflight.get(key)
    if (existing) return existing
    const job = (async () => {
      const { events } = await source.read(sessionId, fromSeq - 1, toSeq)
      const { bytes } = eventNdjson(events)
      if (sha256Hex(bytes) !== hash) throw new HttpError(409, 'STALE', 'Chunk hash does not match this range.')
      return bytes
    })()
    inflight.set(key, job)
    try {
      return await job
    } finally {
      inflight.delete(key)
    }
  }

  return {
    async manifest(sessionId: string, throughSeq?: number, afterSeq?: number): Promise<Manifest> {
      const plan = await planOf(sessionId, throughSeq)
      const after = afterSeq == null ? -1 : afterSeq
      const chunks: EventChunk[] = after < 0 ? plan.chunks : plan.chunks.filter(chunk => chunk.toSeq > after)
      return { ...plan, chunks }
    },
    async chunk(sessionId: string, fromSeq: number, toSeq: number, hash: string) {
      if (hash === '' || !Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) {
        throw new HttpError(400, 'VALIDATION', 'fromSeq, toSeq, and hash are required.')
      }
      return chunkBytes(sessionId, fromSeq, toSeq, hash)
    },
    async range(sessionId: string, afterSeq: number, throughSeq: number | undefined, limit: number) {
      const pageLimit = Math.min(Math.max(1, limit), RANGE_PAGE_LIMIT)
      const { events, throughSeq: pin } = await source.read(sessionId, afterSeq, throughSeq)
      const page = events.slice(0, pageLimit)
      const last = page.length === 0 ? afterSeq : page[page.length - 1]!.seq
      const nextAfterSeq = last < pin && page.length === pageLimit ? last : null
      return { events: page, throughSeq: pin, nextAfterSeq }
    },
  }
}

export type LogSnapshotService = ReturnType<typeof createLogSnapshotService>
