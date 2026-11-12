import { ENHANCE_RANGE_PATH, RANGE_PAGE_LIMIT } from './constants.ts'
import type { BoundedTransport } from './transport.ts'
import { collectEvents } from './ws-follow.ts'
import type { LogEvent } from './types.ts'

export function createPluginRangeTransport(options: { fetch?: typeof fetch; url?: string } = {}): BoundedTransport {
  const post = options.fetch ?? fetch
  const url = options.url ?? ENHANCE_RANGE_PATH
  return {
    kind: 'plugin-range',
    async fetch(req, sink, signal) {
      if (req.throughSeq <= req.afterSeq) return { ok: true, throughSeq: req.throughSeq }
      let afterSeq = req.afterSeq
      try {
        while (!signal.aborted) {
          const query = new URLSearchParams({
            sessionId: req.sessionId,
            afterSeq: String(afterSeq),
            throughSeq: String(req.throughSeq),
            limit: String(RANGE_PAGE_LIMIT),
          })
          const response = await post(`${url}?${query}`, {
            method: 'GET',
            credentials: 'same-origin',
            signal,
            headers: { accept: 'application/json' },
          })
          if (response.status === 404) return { ok: false, retryable: false, code: 'ENHANCE_UNAVAILABLE' }
          if (!response.ok)
            return {
              ok: false,
              retryable: response.status >= 500,
              code: 'RANGE_ERROR',
              message: `HTTP ${response.status}`,
            }
          const body = (await response.json()) as {
            events?: unknown
            throughSeq?: number
            nextAfterSeq?: number | null
          }
          const events = collectEvents(body.events) as LogEvent[]
          if (events.length) sink.events(events, { throughSeq: req.throughSeq })
          if (body.nextAfterSeq == null) return { ok: true, throughSeq: req.throughSeq }
          if (body.nextAfterSeq <= afterSeq) return { ok: false, retryable: true, code: 'RANGE_STALLED' }
          afterSeq = body.nextAfterSeq
        }
        return { ok: false, retryable: false, code: 'ABORTED' }
      } catch (error) {
        if (signal.aborted) return { ok: false, retryable: false, code: 'ABORTED' }
        return {
          ok: false,
          retryable: true,
          code: 'RANGE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

export async function probeEnhancement(
  fetchImpl: typeof fetch = fetch,
  path = ENHANCE_RANGE_PATH,
  signal?: AbortSignal,
) {
  try {
    const response = await fetchImpl(path, { method: 'HEAD', credentials: 'same-origin', signal })
    return response.ok
  } catch {
    return false
  }
}
