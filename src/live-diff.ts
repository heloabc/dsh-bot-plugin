/**
 * Diff between two live documents.
 * The first frame on a connection is the whole value. Every later frame is one of these patches.
 * Objects merge by key. Lists of records merge by a stable id, so one changed session or ticket
 * does not repeat the rest of the list.
 */

export type LivePatch =
  | { t: 'v'; v: unknown }
  | { t: 'o'; s: Record<string, LivePatch>; d?: string[] }
  | { t: 'l'; id: string; s?: Record<string, LivePatch>; d?: string[]; order?: string[] }

/** Append user/assistant messages kept on session/follow. Older history is the CDC prefix. */
export const FOLLOW_TAIL_MESSAGES = 4

const ID_FIELDS = ['sessionId', 'id', 'event_id', 'ticket.id', 'from', 'date', 'model']

function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readId(item: unknown, field: string): string | undefined {
  if (!isObject(item)) return undefined
  if (field === 'ticket.id') {
    const ticket = item.ticket
    if (!isObject(ticket)) return undefined
    const id = ticket.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  const id = item[field]
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return undefined
}

function listField(items: unknown[]): string | null {
  if (items.length === 0) return null
  for (const field of ID_FIELDS) {
    const seen = new Set<string>()
    let ok = true
    for (const item of items) {
      const id = readId(item, field)
      if (id === undefined || seen.has(id)) {
        ok = false
        break
      }
      seen.add(id)
    }
    if (ok) return field
  }
  return null
}

export function diffValue(prev: unknown, next: unknown): LivePatch | null {
  if (stable(prev) === stable(next)) return null
  if (isObject(prev) && isObject(next)) return diffObject(prev, next)
  if (Array.isArray(prev) && Array.isArray(next)) {
    const listed = diffList(prev, next)
    if (listed) return listed
  }
  return { t: 'v', v: next }
}

function diffObject(prev: Record<string, unknown>, next: Record<string, unknown>): LivePatch | null {
  const set: Record<string, LivePatch> = {}
  const del: string[] = []
  for (const key of Object.keys(prev)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) del.push(key)
  }
  for (const key of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(prev, key)) {
      set[key] = { t: 'v', v: next[key] }
      continue
    }
    const child = diffValue(prev[key], next[key])
    if (child) set[key] = child
  }
  if (Object.keys(set).length === 0 && del.length === 0) return null
  return del.length > 0 ? { t: 'o', s: set, d: del } : { t: 'o', s: set }
}

function diffList(prev: unknown[], next: unknown[]): LivePatch | null {
  const prevField = listField(prev)
  const nextField = listField(next)
  if (prev.length > 0 && !prevField) return null
  if (next.length > 0 && !nextField) return null
  if (prevField && nextField && prevField !== nextField) return null
  const field = nextField || prevField
  if (!field) return null
  const prevById = new Map(prev.map(item => [readId(item, field), item]))
  const set: Record<string, LivePatch> = {}
  const del: string[] = []
  const nextIds = next.map(item => readId(item, field) ?? '')
  const seen = new Set(nextIds)
  for (const item of prev) {
    const id = readId(item, field)
    if (id !== undefined && !seen.has(id)) del.push(id)
  }
  for (const item of next) {
    const id = readId(item, field)
    if (id === undefined) continue
    if (!prevById.has(id)) {
      set[id] = { t: 'v', v: item }
      continue
    }
    const child = diffValue(prevById.get(id), item)
    if (child) set[id] = child
  }
  const prevIds = prev.map(item => readId(item, field) ?? '')
  const orderChanged = prevIds.length !== nextIds.length || prevIds.some((id, index) => id !== nextIds[index])
  if (Object.keys(set).length === 0 && del.length === 0 && !orderChanged) return null
  const patch: LivePatch = { t: 'l', id: field }
  if (Object.keys(set).length > 0) patch.s = set
  if (del.length > 0) patch.d = del
  if (orderChanged) patch.order = nextIds
  return patch
}

export function applyValue(prev: unknown, patch: unknown): unknown {
  if (!isObject(patch) || (patch.t !== 'v' && patch.t !== 'o' && patch.t !== 'l')) return prev
  const node = patch as LivePatch
  if (node.t === 'v') return node.v
  if (node.t === 'o') return applyObject(prev, node)
  return applyList(prev, node)
}

function applyObject(prev: unknown, patch: { s: Record<string, LivePatch>; d?: string[] }): Record<string, unknown> {
  const base: Record<string, unknown> = isObject(prev) ? { ...prev } : {}
  for (const key of patch.d ?? []) delete base[key]
  for (const [key, child] of Object.entries(patch.s)) base[key] = applyValue(base[key], child)
  return base
}

function applyList(
  prev: unknown,
  patch: { id: string; s?: Record<string, LivePatch>; d?: string[]; order?: string[] },
): unknown[] {
  const field = patch.id
  const items = Array.isArray(prev) ? prev.slice() : []
  const removed = new Set(patch.d ?? [])
  const kept: unknown[] = []
  const index = new Map<string, number>()
  for (const item of items) {
    const id = readId(item, field)
    if (id !== undefined && removed.has(id)) continue
    if (id !== undefined) index.set(id, kept.length)
    kept.push(item)
  }
  for (const [id, child] of Object.entries(patch.s ?? {})) {
    const at = index.get(id)
    if (at === undefined) {
      kept.push(applyValue(undefined, child))
      continue
    }
    kept[at] = applyValue(kept[at], child)
  }
  if (!patch.order) return kept
  const byId = new Map<string, unknown>()
  for (const item of kept) {
    const id = readId(item, field)
    if (id !== undefined) byId.set(id, item)
  }
  return patch.order.filter(id => byId.has(id)).map(id => byId.get(id))
}
