/** Last list line for each session. One JSON file, replaced atomically. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SESSION_ID = /^(?:session|worker)-[A-Za-z0-9-]+$/
const MAX_PREVIEW = 80
const MAX_ENTRIES = 500

/**
 * @param {string} file
 */
export function openSessionPreviews(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let state: Record<string, string> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    state = sanitize(parsed)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error
  }
  const save = () => {
    const next = `${file}.${process.pid}.tmp`
    writeFileSync(next, JSON.stringify(state), { mode: 0o600 })
    renameSync(next, file)
  }
  return {
    all(): Record<string, string> {
      return { ...state }
    },
    /**
     * @param {unknown} sessionId
     * @param {unknown} preview
     * @returns {{ ok: true, preview: string } | { ok: false, error: 'bad_session' | 'empty_preview' }}
     */
    remember(
      sessionId: unknown,
      preview: unknown,
    ): { ok: true; preview: string } | { ok: false; error: 'bad_session' | 'empty_preview' } {
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { ok: false, error: 'bad_session' }
      const text = cleanPreview(preview)
      if (text === '') return { ok: false, error: 'empty_preview' }
      if (state[sessionId] !== text) {
        state[sessionId] = text
        save()
      }
      return { ok: true, preview: text }
    },
    /**
     * Skip bad rows. A browser cache can contain ids this store will not keep.
     * @param {unknown} incoming
     */
    rememberAll(incoming: unknown) {
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { stored: 0 }
      let changed = false
      let stored = 0
      for (const [sessionId, preview] of Object.entries(incoming)) {
        if (stored >= MAX_ENTRIES) break
        if (!SESSION_ID.test(sessionId)) continue
        const text = cleanPreview(preview)
        if (text === '') continue
        stored += 1
        if (state[sessionId] === text) continue
        state[sessionId] = text
        changed = true
      }
      if (changed) save()
      return { stored }
    },
    /**
     * @param {string} sessionId
     */
    forget(sessionId: string) {
      if (!Object.prototype.hasOwnProperty.call(state, sessionId)) return
      delete state[sessionId]
      save()
    },
  }
}

/**
 * @param {unknown} parsed
 * @returns {Record<string, string>}
 */
function sanitize(parsed: unknown): Record<string, string> {
  /** @type {Record<string, string>} */
  const out: Record<string, string> = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [sessionId, preview] of Object.entries(parsed)) {
    if (!SESSION_ID.test(sessionId)) continue
    const text = cleanPreview(preview)
    if (text === '') continue
    out[sessionId] = text
  }
  return out
}

/**
 * @param {unknown} value
 */
function cleanPreview(value: unknown) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW)
}
