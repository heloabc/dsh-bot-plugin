/** Admission and host budgets. Neither function calls a model or reorders an inbox. */

export interface WorkBudget {
  mainMaxSteps: number
  mainWallMs: number
  chatMaxSteps: number
  chatWallMs: number
  holdMs: number
  workerMaxSteps: number
  workerWallMs: number
  workerMaxTokens: number
  perBot: number
  global: number
  leaseMs: number
  starveMs: number
  mergeWindowMs: number
}

export const DEFAULT_WORK_BUDGET: WorkBudget = Object.freeze({
  mainMaxSteps: 2,
  mainWallMs: 20_000,
  chatMaxSteps: 4,
  chatWallMs: 120_000,
  holdMs: 15_000,
  workerMaxSteps: 8,
  workerWallMs: 10 * 60 * 1000,
  workerMaxTokens: 400_000,
  perBot: 1,
  global: 2,
  leaseMs: 60_000,
  starveMs: 30_000,
  mergeWindowMs: 1_000,
})

/**
 * Pending next-turn ids whose source is not a ticket notice and not a delivery.
 * @param {string[]} pendingIds
 * @param {Iterable<string>} backgroundIds
 */
export function userPending(pendingIds: string[], backgroundIds: Iterable<string>) {
  const background = backgroundIds instanceof Set ? backgroundIds : new Set(backgroundIds)
  return pendingIds.filter(id => typeof id === 'string' && id !== '' && !background.has(id))
}

/**
 * @param {{
 *   pendingIds: string[] | null,
 *   backgroundIds?: Iterable<string>,
 *   noticeOpen: boolean,
 *   deliveryOpen: boolean,
 *   lastNoticeAt?: number | null,
 *   nowMs: number,
 *   mergeWindowMs: number,
 *   terminalSince?: number | null,
 *   starveMs: number,
 * }} input
 */
export function decideAdmission(input: {
  pendingIds: string[] | null
  backgroundIds?: Iterable<string>
  noticeOpen: boolean
  deliveryOpen: boolean
  lastNoticeAt?: number | null
  nowMs: number
  mergeWindowMs: number
  terminalSince?: number | null
  starveMs: number
}) {
  if (input.pendingIds == null) return { admit: false, reason: 'inbox-unreadable', starve: false, userAhead: 0 }
  const users = userPending(input.pendingIds, input.backgroundIds ?? [])
  const terminalSince = input.terminalSince ?? null
  const age = terminalSince == null ? null : input.nowMs - terminalSince
  const starve = age != null && age >= input.starveMs
  if (starve) return { admit: true, reason: 'starve', starve: true, userAhead: users.length }
  if (users.length > 0) return { admit: false, reason: 'user-pending', starve: false, userAhead: users.length }
  if (input.noticeOpen) return { admit: false, reason: 'notice-open', starve: false, userAhead: 0 }
  if (input.deliveryOpen) return { admit: false, reason: 'delivery-open', starve: false, userAhead: 0 }
  const last = input.lastNoticeAt ?? null
  if (last != null && input.nowMs - last < input.mergeWindowMs) {
    return { admit: false, reason: 'merge-window', starve: false, userAhead: 0 }
  }
  return { admit: true, reason: 'clear', starve: false, userAhead: 0 }
}

/**
 * @param {{ steps?: number, elapsedMs: number, maxSteps?: number, wallMs: number, tokens?: number, maxTokens?: number }} input
 * @returns {'steps' | 'wall' | 'tokens' | null}
 */
export function budgetTrip(input: {
  steps?: number
  elapsedMs: number
  maxSteps?: number
  wallMs: number
  tokens?: number
  maxTokens?: number
}): 'steps' | 'wall' | 'tokens' | null {
  const maxSteps = input.maxSteps
  const maxTokens = input.maxTokens
  if (maxSteps != null && Number.isFinite(maxSteps) && Number(input.steps) >= maxSteps) return 'steps'
  if (maxTokens != null && Number.isFinite(maxTokens) && Number(input.tokens) >= maxTokens) return 'tokens'
  if (input.elapsedMs >= input.wallMs) return 'wall'
  return null
}

/**
 * Positive integer inside an inclusive range.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function clampInt(value: unknown, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(min, Math.min(max, Math.floor(number)))
}

/**
 * Ticket budget chosen when the main bot dispatches.
 * An explicit estimate is kept inside the host ceiling. An omitted field is
 * derived from the briefing length so every ticket gets its own numbers.
 * @param {string} briefing
 * @param {{ wallMs?: number, maxTokens?: number } | null | undefined} suggestion
 * @param {typeof DEFAULT_WORK_BUDGET} defaults
 */
export function estimateWorkerBudget(
  briefing: string,
  suggestion: { wallMs?: number; maxTokens?: number } | null | undefined,
  defaults: typeof DEFAULT_WORK_BUDGET = DEFAULT_WORK_BUDGET,
) {
  const chars = typeof briefing === 'string' ? briefing.length : 0
  const guessedWall = Math.min(defaults.workerWallMs, 180_000 + chars * 100)
  const guessedTokens = Math.min(defaults.workerMaxTokens, 24_000 + chars * 8)
  return {
    wallMs: clampInt(suggestion?.wallMs, 1000, defaults.workerWallMs) ?? guessedWall,
    maxTokens: clampInt(suggestion?.maxTokens, 1000, defaults.workerMaxTokens) ?? guessedTokens,
    perBot: defaults.perBot,
    global: defaults.global,
  }
}

/**
 * Child creation options. parentAgent and meta.parentSession are omitted on purpose:
 * the parent link lives only on the ticket row.
 * Real DSH rejects a turn when AgentOptions.provider and model are both absent
 * (`has no provider/model`). The deployment default is not applied by create()
 * itself, so the caller copies the owner selection or the deployment default.
 * @param {string} sessionId
 * @param {string} [cwd]
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | null} [model]
 * @param {number} [maxTokens] Test-only output cap. Omit it and the host default stays.
 */
export function childCreateOptions(
  sessionId: string,
  cwd?: string,
  model?: { provider?: string; model?: string; reasoningEffort?: string } | null,
  maxTokens?: number,
) {
  const options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }
    setup?: Function
  } = { sessionId }
  if (typeof cwd === 'string' && cwd !== '') options.meta = { cwd }
  if (
    model &&
    typeof model.provider === 'string' &&
    model.provider !== '' &&
    typeof model.model === 'string' &&
    model.model !== ''
  ) {
    options.agentOptions = { provider: model.provider, model: model.model }
    if (typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '') {
      options.agentOptions.reasoningEffort = model.reasoningEffort
    }
    if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0)
      options.agentOptions.maxTokens = maxTokens
  }
  return options
}
