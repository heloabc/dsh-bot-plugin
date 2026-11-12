import type { HostContext } from '../host.ts'
import { HttpError, RANGE_PAGE_LIMIT, type LogSnapshotService } from './snapshot-service.ts'

export const LOG_ROUTE_PREFIX = '/api/dsh-bot/log'
export const LOG_MANIFEST_PATH = `${LOG_ROUTE_PREFIX}/manifest`
export const LOG_CHUNK_PATH = `${LOG_ROUTE_PREFIX}/chunk`
export const LOG_RANGE_PATH = `${LOG_ROUTE_PREFIX}/range`

type FetchHandler = (request: Request) => Promise<Response>

export function registerLogRoutes(ctx: HostContext, service: LogSnapshotService) {
  const connection = (ctx.get?.('connection') ?? ctx.connection) as
    | {
        fetch?: {
          register?: (route: {
            path: string
            methods: readonly string[]
            requestBody: string
            fetch: FetchHandler
          }) => unknown
        }
      }
    | undefined
  if (connection?.fetch?.register === undefined) return false
  const handlers = logFetchHandlers(service)
  for (const [path, handler] of handlers) {
    ctx.effect?.(() => {
      const dispose = connection.fetch!.register!({
        path,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: handler,
      })
      return typeof dispose === 'function'
        ? () => {
            void dispose()
          }
        : undefined
    })
  }
  return true
}

export function logFetchHandlers(service: LogSnapshotService): Array<[string, FetchHandler]> {
  return [
    [LOG_MANIFEST_PATH, request => handleManifest(service, request)],
    [LOG_CHUNK_PATH, request => handleChunk(service, request)],
    [LOG_RANGE_PATH, request => handleRange(service, request)],
  ]
}

export async function dispatchLogRequest(service: LogSnapshotService, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/'
  const handler = logFetchHandlers(service).find(([route]) => route === path)?.[1]
  if (!handler) return null
  return handler(request)
}

async function handleManifest(service: LogSnapshotService, request: Request) {
  return wrap(request, async url => {
    const sessionId = requiredSession(url)
    const throughSeq = readInt(url, 'throughSeq', true)
    const afterSeq = readInt(url, 'afterSeq', true)
    const body = await service.manifest(sessionId, throughSeq ?? undefined, afterSeq ?? undefined)
    return json(200, body)
  })
}

async function handleChunk(service: LogSnapshotService, request: Request) {
  return wrap(request, async url => {
    const sessionId = requiredSession(url)
    const fromSeq = readInt(url, 'fromSeq', false)
    const toSeq = readInt(url, 'toSeq', false)
    const hash = url.searchParams.get('hash') ?? ''
    if (fromSeq == null || toSeq == null) throw new HttpError(400, 'VALIDATION', 'fromSeq and toSeq are required.')
    const bytes = await service.chunk(sessionId, fromSeq, toSeq, hash)
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'private, immutable',
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const out = new Uint8Array(bytes.byteLength)
    out.set(bytes)
    return new Response(out, { status: 200, headers })
  })
}

async function handleRange(service: LogSnapshotService, request: Request) {
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return wrap(request, async url => {
    const sessionId = requiredSession(url)
    const afterSeq = readInt(url, 'afterSeq', true) ?? -1
    const throughSeq = readInt(url, 'throughSeq', true)
    const limit = readInt(url, 'limit', true) ?? RANGE_PAGE_LIMIT
    if (limit != null && limit <= 0) throw new HttpError(400, 'VALIDATION', 'limit must be a positive integer.')
    const body = await service.range(sessionId, afterSeq, throughSeq ?? undefined, limit ?? RANGE_PAGE_LIMIT)
    return json(200, body)
  })
}

async function wrap(request: Request, run: (url: URL) => Promise<Response>) {
  try {
    const response = await run(new URL(request.url))
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers })
    return response
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { ok: false, code: error.code, message: error.message })
    return json(500, {
      ok: false,
      code: 'UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function requiredSession(url: URL) {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') throw new HttpError(400, 'VALIDATION', 'sessionId is required.')
  return sessionId
}

function readInt(url: URL, name: string, optional: boolean) {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return optional ? null : null
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, 'VALIDATION', `${name} must be an integer.`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new HttpError(400, 'VALIDATION', `${name} must be an integer.`)
  return value
}

function json(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store',
    },
  })
}
