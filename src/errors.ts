/** Structured tool and recovery failures. These are plugin contracts, not DSH errors. */

export const CODES = [
  'BUSY',
  'CAS_CONFLICT',
  'IDEMPOTENCY_KEY_REUSE',
  'NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION',
  'HASH_MISMATCH',
  'BUDGET_OVERFLOW',
  'BUDGET',
  'REVOKED',
  'STORE_FAILURE',
  'UNAVAILABLE',
  'HOP_LIMIT',
  'TTL_EXPIRED',
  'RATE_LIMIT',
  'SIGNATURE',
  'REPLAY',
  'REJECTED',
]

const RETRYABLE = new Set(['BUSY'])

/**
 * Tool and HTTP results are open records. Callers read whichever fields the
 * success or failure path actually returned.
 */
export type ToolPayload = {
  ok: boolean
  [key: string]: any
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export function toolError(code: string, message: string, details?: Record<string, unknown>): ToolPayload {
  return {
    ok: false,
    code,
    message,
    retryable: code === 'CAS_CONFLICT' ? true : RETRYABLE.has(code),
    ...(details ? { details } : {}),
  }
}

/**
 * @param {unknown} error
 */
export function asStoreFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('SQLITE_BUSY') || message.includes('database is locked')) {
    return toolError('BUSY', 'The write lock was not acquired, so nothing was written.')
  }
  return toolError('STORE_FAILURE', message)
}
