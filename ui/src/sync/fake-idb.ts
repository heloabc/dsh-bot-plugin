/** Minimal IndexedDB stand-in for unit tests. */

type Mode = IDBTransactionMode

interface StoreDef {
  keyPath?: string | string[]
  indexes: Map<string, string>
  rows: Map<string, unknown>
}

class FakeNames implements Iterable<string> {
  names: Set<string>
  constructor(names: Set<string>) {
    this.names = names
  }
  contains(name: string) {
    return this.names.has(name)
  }
  [Symbol.iterator]() {
    return this.names[Symbol.iterator]()
  }
}

class FakeRequest<T> {
  result!: T
  error: DOMException | null = null
  onsuccess: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  succeed(result: T) {
    this.result = result
    queueMicrotask(() => this.onsuccess?.(new Event('success')))
  }
  fail(error: DOMException) {
    this.error = error
    queueMicrotask(() => this.onerror?.(new Event('error')))
  }
}

class FakeIndex {
  store: FakeStore
  keyPath: string
  constructor(store: FakeStore, keyPath: string) {
    this.store = store
    this.keyPath = keyPath
  }
  getAll(query?: unknown) {
    const request = new FakeRequest<unknown[]>()
    const rows = [...this.store.rows.values()].filter(row =>
      query === undefined ? true : (row as any)?.[this.field()] === query || (row as any)?.sessionId === query,
    )
    request.succeed(rows)
    return request as unknown as IDBRequest<unknown[]>
  }
  getAllKeys() {
    const request = new FakeRequest<IDBValidKey[]>()
    request.succeed([...this.store.rows.keys()])
    return request as unknown as IDBRequest<IDBValidKey[]>
  }
  private field() {
    return this.keyPath
  }
}

class FakeStore {
  def: StoreDef
  constructor(def: StoreDef) {
    this.def = def
  }
  get rows() {
    return this.def.rows
  }
  index(name: string) {
    const path = this.def.indexes.get(name) ?? name
    return new FakeIndex(this, path) as unknown as IDBIndex
  }
  get(key: unknown) {
    const request = new FakeRequest<unknown>()
    request.succeed(this.rows.get(encodeKey(key)))
    return request as unknown as IDBRequest<unknown>
  }
  put(value: unknown, key?: unknown) {
    const request = new FakeRequest<unknown>()
    const storedKey = key ?? readKey(value, this.def.keyPath)
    this.rows.set(encodeKey(storedKey), value)
    request.succeed(storedKey)
    return request as unknown as IDBRequest<unknown>
  }
  delete(key: unknown) {
    const request = new FakeRequest<undefined>()
    this.rows.delete(encodeKey(key))
    request.succeed(undefined)
    return request as unknown as IDBRequest<undefined>
  }
}

class FakeTransaction {
  error: DOMException | null = null
  onerror: ((event: Event) => void) | null = null
  db: FakeDatabase
  constructor(db: FakeDatabase, _name: string) {
    this.db = db
  }
  objectStore(name: string) {
    const def = this.db.stores.get(name)
    if (!def) throw new Error(`missing store ${name}`)
    return new FakeStore(def) as unknown as IDBObjectStore
  }
}

class FakeDatabase {
  onversionchange: (() => void) | null = null
  objectStoreNames: FakeNames
  name: string
  version: number
  stores: Map<string, StoreDef>
  constructor(name: string, version: number, stores: Map<string, StoreDef>) {
    this.name = name
    this.version = version
    this.stores = stores
    this.objectStoreNames = new FakeNames(new Set(stores.keys()))
  }
  createObjectStore(name: string, options: IDBObjectStoreParameters = {}) {
    const def: StoreDef = {
      keyPath: options.keyPath as string | string[] | undefined,
      indexes: new Map(),
      rows: new Map(),
    }
    this.stores.set(name, def)
    this.objectStoreNames = new FakeNames(new Set(this.stores.keys()))
    return {
      createIndex: (indexName: string, keyPath: string) => {
        def.indexes.set(indexName, keyPath)
      },
    }
  }
  deleteObjectStore(name: string) {
    this.stores.delete(name)
    this.objectStoreNames = new FakeNames(new Set(this.stores.keys()))
  }
  transaction(name: string, _mode: Mode) {
    return new FakeTransaction(this, name) as unknown as IDBTransaction
  }
  close() {}
}

class FakeOpenRequest {
  result!: FakeDatabase
  error: DOMException | null = null
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null
  onblocked: (() => void) | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
}

export interface FakeIndexedDB extends IDBFactory {
  seedV1(data: { chunks: Record<string, unknown>; events: Record<string, unknown> }): Promise<void>
}

export function installFakeIndexedDB(options: { blockUpgrade?: boolean } = {}): FakeIndexedDB {
  const dbs = new Map<string, FakeDatabase>()
  const factory = {
    open(name: string, version?: number) {
      const request = new FakeOpenRequest()
      const current = dbs.get(name)
      const nextVersion = version ?? current?.version ?? 1
      queueMicrotask(() => {
        if (options.blockUpgrade && current && current.version < nextVersion) {
          request.onblocked?.()
          return
        }
        const oldVersion = current?.version ?? 0
        const stores = current?.stores ?? new Map<string, StoreDef>()
        const db = new FakeDatabase(name, nextVersion, stores)
        dbs.set(name, db)
        request.result = db
        if (oldVersion < nextVersion) {
          const event = { oldVersion, newVersion: nextVersion, target: request } as unknown as IDBVersionChangeEvent
          request.onupgradeneeded?.(event)
        }
        request.onsuccess?.()
      })
      return request as unknown as IDBOpenDBRequest
    },
    deleteDatabase(name: string) {
      dbs.delete(name)
      const request = new FakeRequest<undefined>()
      request.succeed(undefined)
      return request as unknown as IDBOpenDBRequest
    },
    cmp() {
      return 0
    },
    databases: async () => [],
    async seedV1(data: { chunks: Record<string, unknown>; events: Record<string, unknown> }) {
      const stores = new Map<string, StoreDef>([
        ['chunks', { rows: new Map(Object.entries(data.chunks)), indexes: new Map() }],
        ['events', { rows: new Map(Object.entries(data.events)), indexes: new Map() }],
      ])
      dbs.set('dsh-bot', new FakeDatabase('dsh-bot', 1, stores))
    },
  }
  return factory as unknown as FakeIndexedDB
}

function encodeKey(key: unknown) {
  return JSON.stringify(key)
}

function readKey(value: unknown, keyPath?: string | string[]) {
  if (!keyPath || !value || typeof value !== 'object') return value
  if (Array.isArray(keyPath)) return keyPath.map(part => (value as Record<string, unknown>)[part])
  return (value as Record<string, unknown>)[keyPath]
}
