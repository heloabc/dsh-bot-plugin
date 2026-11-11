/** Local copy of session events and of the CDC chunks that built a snapshot. */

export interface CachedEvent {
  sessionId: string
  seq: number
  type: string
  time?: number
  event: Record<string, unknown>
  bytes: number
}

export interface ChunkCache {
  open(): Promise<'ready' | 'unavailable'>
  present(hashes: readonly string[]): Promise<Set<string>>
  readChunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>>
  putChunks(chunks: ReadonlyMap<string, Uint8Array>): Promise<void>
  readEvents(sessionId: string): Promise<CachedEvent[]>
  putEvents(sessionId: string, events: CachedEvent[]): Promise<void>
}

const CHUNK_CAP = 64 * 1024 * 1024

export function cachedEvent(sessionId: string, event: Record<string, unknown>): CachedEvent | null {
  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) return null
  if (typeof event.type !== 'string' || !event.type.includes('/')) return null
  if (event.type.includes('live-chunk') || event.type.includes('stream')) return null
  const text = JSON.stringify(event)
  return {
    sessionId,
    seq: event.seq,
    type: event.type,
    ...(typeof event.time === 'number' ? { time: event.time } : {}),
    event,
    bytes: new TextEncoder().encode(text).length,
  }
}

export function memoryCache(): ChunkCache {
  const chunks = new Map<string, Uint8Array>()
  const order: string[] = []
  let used = 0
  const events = new Map<string, Map<number, CachedEvent>>()
  return {
    async open() {
      return 'ready'
    },
    async present(hashes) {
      return new Set(hashes.filter(hash => chunks.has(hash)))
    },
    async readChunks(hashes) {
      const out = new Map<string, Uint8Array>()
      for (const hash of hashes) {
        const body = chunks.get(hash)
        if (body) out.set(hash, body)
      }
      return out
    },
    async putChunks(incoming) {
      for (const [hash, body] of incoming) {
        const previous = chunks.get(hash)
        if (previous) used -= previous.byteLength
        chunks.set(hash, body)
        const index = order.indexOf(hash)
        if (index >= 0) order.splice(index, 1)
        order.push(hash)
        used += body.byteLength
      }
      while (used > CHUNK_CAP && order.length > 0) {
        const hash = order.shift()
        if (!hash) break
        const body = chunks.get(hash)
        if (body) used -= body.byteLength
        chunks.delete(hash)
      }
    },
    async readEvents(sessionId) {
      const rows = events.get(sessionId)
      if (!rows) return []
      return [...rows.values()].sort((left, right) => left.seq - right.seq)
    },
    async putEvents(sessionId, rows) {
      const bucket = events.get(sessionId) ?? new Map<number, CachedEvent>()
      events.set(sessionId, bucket)
      for (const row of rows) {
        if (row.sessionId !== sessionId) continue
        bucket.set(row.seq, row)
      }
    },
  }
}

function eventKey(sessionId: string, seq: number): string {
  return `${sessionId}\u0000${seq}`
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function idbCache(): ChunkCache {
  let opened: Promise<IDBDatabase> | null = null
  const openDb = () => {
    if (!opened) {
      opened = new Promise((resolve, reject) => {
        const request = indexedDB.open('dsh-bot', 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks')
          if (!db.objectStoreNames.contains('events')) {
            const store = db.createObjectStore('events')
            store.createIndex('bySession', 'sessionId')
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return opened
  }
  return {
    async open() {
      try {
        await openDb()
        return 'ready'
      } catch {
        return 'unavailable'
      }
    },
    async present(hashes) {
      const db = await openDb()
      const found = new Set<string>()
      const store = db.transaction('chunks', 'readonly').objectStore('chunks')
      await Promise.all(
        hashes.map(async hash => {
          const body = bytesOf(await requestToPromise(store.get(hash)))
          if (body) found.add(hash)
        }),
      )
      return found
    },
    async readChunks(hashes) {
      const db = await openDb()
      const out = new Map<string, Uint8Array>()
      const store = db.transaction('chunks', 'readonly').objectStore('chunks')
      await Promise.all(
        hashes.map(async hash => {
          const body = bytesOf(await requestToPromise(store.get(hash)))
          if (body) out.set(hash, body)
        }),
      )
      return out
    },
    async putChunks(incoming) {
      const db = await openDb()
      const tx = db.transaction('chunks', 'readwrite')
      const store = tx.objectStore('chunks')
      for (const [hash, body] of incoming) {
        const copy = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? body : body.slice()
        store.put(copy, hash)
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
    async readEvents(sessionId) {
      const db = await openDb()
      const store = db.transaction('events', 'readonly').objectStore('events')
      const index = store.index('bySession')
      const rows = await requestToPromise(index.getAll(sessionId))
      if (!Array.isArray(rows)) return []
      return rows
        .filter(
          (row): row is CachedEvent => !!row && typeof row === 'object' && typeof (row as CachedEvent).seq === 'number',
        )
        .sort((left, right) => left.seq - right.seq)
    },
    async putEvents(sessionId, rows) {
      const db = await openDb()
      const tx = db.transaction('events', 'readwrite')
      const store = tx.objectStore('events')
      for (const row of rows) {
        if (row.sessionId !== sessionId) continue
        store.put(row, eventKey(sessionId, row.seq))
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
  }
}

export function browserCache(): ChunkCache {
  if (typeof indexedDB === 'undefined') return memoryCache()
  const primary = idbCache()
  const fallback = memoryCache()
  return {
    async open() {
      const status = await primary.open()
      return status === 'ready' ? status : fallback.open()
    },
    async present(hashes) {
      try {
        return await primary.present(hashes)
      } catch {
        return fallback.present(hashes)
      }
    },
    async readChunks(hashes) {
      try {
        return await primary.readChunks(hashes)
      } catch {
        return fallback.readChunks(hashes)
      }
    },
    async putChunks(chunks) {
      try {
        await primary.putChunks(chunks)
      } catch {
        await fallback.putChunks(chunks)
      }
    },
    async readEvents(sessionId) {
      try {
        return await primary.readEvents(sessionId)
      } catch {
        return fallback.readEvents(sessionId)
      }
    },
    async putEvents(sessionId, events) {
      try {
        await primary.putEvents(sessionId, events)
      } catch {
        await fallback.putEvents(sessionId, events)
      }
    },
  }
}
