/**
 * Shared follow-up durability. The caller decides which ledger table is updated.
 * Algorithm matches deliveries: flushing, then followup, then flush.
 * Flush unconfirmed is ambiguous. This is at-least-once, not exactly-once.
 */

const MAX_ATTEMPTS = 5

/**
 * @param {{
 *   attempts: number,
 *   markFlushing: () => void,
 *   push: () => Promise<{ ok?: boolean, ambiguous?: boolean, seq?: number | null, error?: string }>,
 *   markAccepted: (seq: number | null) => void,
 *   markAmbiguous: (error: string) => void,
 *   markDead: (error: string) => void,
 *   markRetry: (error: string) => void,
 * }} spec
 */
export async function durableFollowup(spec: {
  attempts: number
  markFlushing: () => void
  push: () => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  markAccepted: (seq: number | null) => void
  markAmbiguous: (error: string) => void
  markDead: (error: string) => void
  markRetry: (error: string) => void
}) {
  if (spec.attempts >= MAX_ATTEMPTS) {
    spec.markDead('retry-limit')
    return { ok: false, status: 'dead' }
  }
  spec.markFlushing()
  try {
    const result = await spec.push()
    if (result?.ok) {
      spec.markAccepted(result.seq ?? null)
      return { ok: true, status: 'accepted', seq: result.seq ?? null }
    }
    if (result?.ambiguous) {
      spec.markAmbiguous(result.error || 'flush-unconfirmed')
      return { ok: false, status: 'ambiguous' }
    }
    const used = spec.attempts + 1
    const error = result?.error || 'push-failed'
    if (used >= MAX_ATTEMPTS) {
      spec.markDead(error)
      return { ok: false, status: 'dead' }
    }
    spec.markRetry(error)
    return { ok: false, status: 'intent' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not found') || message.includes('NotFound') || message.includes('no session')) {
      spec.markDead('target-not-found')
      return { ok: false, status: 'dead' }
    }
    spec.markAmbiguous(message)
    return { ok: false, status: 'ambiguous' }
  }
}

export const DURABLE_ATTEMPT_LIMIT = MAX_ATTEMPTS
