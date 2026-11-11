import { cachedEvent, type CachedEvent, type ChunkCache } from './cache.ts'
import { assembleDocument, hashBatches, hashList, mergeChunkBodies, missingHashes } from './live.ts'

interface JsonGet {
  (
    path: string,
    onBytes?: (received: number, total: number | null) => void,
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface ChunkProgress {
  loaded: number
  total: number
}

function eventsOf(value: unknown, sessionId: string): CachedEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = cachedEvent(sessionId, item as Record<string, unknown>)
    return row ? [row] : []
  })
}

export interface SessionSnapshot {
  events: unknown[] | null
  beforeSeq: number | null
}

function prefixRows(rows: CachedEvent[], beforeSeq: number | null): CachedEvent[] {
  if (beforeSeq == null) return rows
  return rows.filter(row => row.seq < beforeSeq)
}

/**
 * Open the part of a session log that follow will not deliver.
 * `beforeSeq` is an explicit cut. `tailMessages` asks the server to cut off the follow opening page.
 * Hashes already in the cache are not requested. An empty prefix returns no chunk calls.
 * When the event cache already holds every prefix event, the chunk bodies stay put and no load progress is reported.
 */
export async function loadSessionSnapshot(
  sessionId: string,
  cache: ChunkCache,
  get: JsonGet,
  onProgress?: (progress: ChunkProgress) => void,
  attempt = 0,
  beforeSeq?: number,
  tailMessages?: number,
): Promise<SessionSnapshot> {
  const scope =
    beforeSeq != null && beforeSeq > 0
      ? `&beforeSeq=${beforeSeq}`
      : tailMessages != null && tailMessages > 0
        ? `&tailMessages=${tailMessages}`
        : ''
  const listed = await get(`/snapshot?sessionId=${encodeURIComponent(sessionId)}${scope}`)
  const reported = typeof listed.body.beforeSeq === 'number' ? listed.body.beforeSeq : (beforeSeq ?? null)
  if (listed.status !== 200 || listed.body.ok !== true) return { events: null, beforeSeq: reported }
  const hashes = hashList(listed.body.hashes)
  const totalSize = listed.body.totalSize
  if (!hashes || typeof totalSize !== 'number') return { events: null, beforeSeq: reported }
  const count = listed.body.count
  if (typeof count === 'number') {
    try {
      const stored = await cache.readEvents(sessionId)
      const prefix = prefixRows(stored, reported)
      if (prefix.length === count) return { events: prefix.map(row => row.event), beforeSeq: reported }
    } catch {
      /* a cache read failure still falls through to the chunk plan */
    }
  }
  if (hashes.length === 0) {
    onProgress?.({ loaded: 0, total: totalSize })
    return { events: [], beforeSeq: reported }
  }
  const have = await cache.present(hashes)
  const missing = missingHashes(hashes, have)
  const cached = await cache.readChunks(hashes.filter(hash => have.has(hash)))
  let loaded = 0
  for (const hash of hashes) {
    if (!have.has(hash)) continue
    loaded += cached.get(hash)?.byteLength ?? 0
  }
  let shown = 0
  const report = (extra = 0) => {
    shown = Math.max(shown, Math.min(totalSize, loaded + extra))
    onProgress?.({ loaded: shown, total: totalSize })
  }
  report()
  let pending = missing.length
  for (const batch of hashBatches(missing, 1)) {
    const query = batch.map(hash => `hash=${encodeURIComponent(hash)}`).join('&')
    const remaining = Math.max(0, totalSize - loaded)
    const share = pending === 0 ? 0 : remaining * (batch.length / pending)
    const part = await get(
      `/snapshot/chunks?sessionId=${encodeURIComponent(sessionId)}&${query}`,
      (received, httpTotal) => {
        const fraction =
          httpTotal != null && httpTotal > 0
            ? Math.min(1, received / httpTotal)
            : Math.min(0.9, received / Math.max(share, 1))
        report(share * fraction)
      },
    )
    if (part.status === 409 && attempt === 0)
      return loadSessionSnapshot(sessionId, cache, get, onProgress, 1, beforeSeq, tailMessages)
    if (part.status !== 200 || part.body.ok !== true) return { events: null, beforeSeq: reported }
    const decoded = new Map<string, Uint8Array>()
    mergeChunkBodies(decoded, part.body.chunks)
    if (missingHashes(batch, new Set(decoded.keys())).length > 0) return { events: null, beforeSeq: reported }
    await cache.putChunks(decoded)
    for (const hash of batch) loaded += decoded.get(hash)?.byteLength ?? 0
    pending -= batch.length
    report()
  }
  const chunks = await cache.readChunks(hashes)
  const parsed = assembleDocument(hashes, chunks, totalSize)
  if (!Array.isArray(parsed)) return { events: null, beforeSeq: reported }
  const rows = eventsOf(parsed, sessionId)
  if (rows.length > 0) await cache.putEvents(sessionId, rows)
  return { events: parsed, beforeSeq: reported }
}

/** The few events between the CDC prefix and a follow page that started later. */
export async function loadSessionRange(
  sessionId: string,
  fromSeq: number,
  beforeSeq: number | undefined,
  get: JsonGet,
): Promise<unknown[] | null> {
  const upper = beforeSeq != null ? `&beforeSeq=${beforeSeq}` : ''
  const listed = await get(`/snapshot/range?sessionId=${encodeURIComponent(sessionId)}&fromSeq=${fromSeq}${upper}`)
  if (listed.status !== 200 || listed.body.ok !== true || !Array.isArray(listed.body.events)) return null
  return listed.body.events
}
