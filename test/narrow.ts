/**
 * Keep the union member that actually has `key`.
 * Runtime checks already expect that field; this makes the same check a type narrowing.
 */
export function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing')
  return value
}

export function field<T, K extends PropertyKey>(value: T, key: K): T & { [P in K]: any } {
  if (value === null || typeof value !== 'object' || !(key in value)) {
    const message = value !== null && typeof value === 'object' && 'message' in value ? String(value.message) : ''
    throw new Error(`missing ${String(key)}${message === '' ? '' : `: ${message}`}`)
  }
  return value as T & { [P in K]: any }
}
