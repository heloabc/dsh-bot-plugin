export const DB_NAME = 'dsh-bot'
export const DB_VERSION = 2

export type OpenLogDbResult = { ok: true; db: IDBDatabase } | { ok: false; reason: 'blocked' | 'unavailable' }

const NEW_STORES = ['log_chunks', 'log_events', 'log_cursors'] as const

export function openLogDb(factory?: IDBFactory): Promise<OpenLogDbResult> {
  const indexedDBImpl = factory ?? globalThis.indexedDB
  if (!indexedDBImpl) return Promise.resolve({ ok: false, reason: 'unavailable' })
  return new Promise(resolve => {
    let settled = false
    const finish = (result: OpenLogDbResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const request = indexedDBImpl.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = event => {
        const db = request.result
        const from = event.oldVersion
        if (from < 2) {
          for (const old of ['chunks', 'events']) {
            if (db.objectStoreNames.contains(old)) db.deleteObjectStore(old)
          }
          if (!db.objectStoreNames.contains('log_chunks')) {
            const chunks = db.createObjectStore('log_chunks')
            chunks.createIndex('byLastUsed', 'lastUsed')
          }
          if (!db.objectStoreNames.contains('log_events')) {
            const events = db.createObjectStore('log_events', { keyPath: ['sessionId', 'seq'] })
            events.createIndex('bySession', 'sessionId')
          }
          if (!db.objectStoreNames.contains('log_cursors'))
            db.createObjectStore('log_cursors', { keyPath: 'sessionId' })
        }
      }
      request.onblocked = () => finish({ ok: false, reason: 'blocked' })
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        if (!NEW_STORES.every(name => db.objectStoreNames.contains(name))) {
          db.close()
          finish({ ok: false, reason: 'unavailable' })
          return
        }
        finish({ ok: true, db })
      }
      request.onerror = () => finish({ ok: false, reason: 'unavailable' })
    } catch {
      finish({ ok: false, reason: 'unavailable' })
    }
  })
}
