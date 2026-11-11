import { randomUUID } from 'node:crypto'
import { sha256 } from './fs-safe.ts'
import { toolError } from './errors.ts'
import { createTicketBook } from './work-tickets.ts'
import { decideAdmission, budgetTrip, estimateWorkerBudget, DEFAULT_WORK_BUDGET } from './work-admit.ts'
import {
  messageIdOf,
  pushInput,
  pushNotice,
  reasonKindOf,
  reconcileInputs,
  reconcileNotices,
  renderNotice,
} from './work-ledger.ts'

const KINDS = new Set(['progress', 'question', 'artifact', 'result', 'failure'])
const LABEL: Record<string, string> = {
  accepted: 'accepted',
  enqueued: 'enqueued',
  started: 'started',
  needs_user: 'needs user',
  ready: 'candidate',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
}

type BudgetArm = {
  turn: number
  startedAt: number
  steps: number
  tokens: number
  lastSeq: number | null
  role: 'main' | 'worker'
  tight: boolean
  limits: { maxSteps: number; wallMs: number; maxTokens: number; ceilingWall: number; ceilingTokens: number }
  tripped: boolean
  extensionOpen: boolean
  closing: boolean
  clear: () => void
}

type WorkHostOptions = {
  createChild?: (spec: {
    sessionId: string
    ownerSessionId: string
    ticketId: string
    fencingToken: number
  }) => Promise<string>
  push?: (
    sessionId: string,
    messageId: string,
    text: string,
  ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  logHas?: (sessionId: string, messageId: string) => Promise<boolean> | boolean
  remove?: (sessionId: string, messageId: string) => Promise<boolean> | boolean
  pendingIds?: (sessionId: string) => Promise<string[] | null> | string[] | null
  cancel?: (sessionId: string, options: { keepInbox?: boolean }) => Promise<void> | void
  snapshot?: (sessionId: string) => Promise<Array<Record<string, any>>> | Array<Record<string, any>>
  resident?: boolean
  pid?: number
  now?: () => Date
  budget?: Partial<typeof DEFAULT_WORK_BUDGET>
  schedule?: (fn: () => void, ms: number) => () => void
}

/**
 * Host-side ticket protocol. The model is not called from here.
 * Native inbox delivery stays in `options.push` / `options.pendingIds`.
 * @param {import('./store.js').Store} store
 * @param {import('./engine.js').Engine} engine
 */
export function createWorkRuntime(
  store: import('./store.ts').Store,
  engine: import('./engine.ts').Engine,
  options: WorkHostOptions = {},
) {
  const now = options.now ?? (() => new Date())
  const limits = { ...DEFAULT_WORK_BUDGET, ...options.budget }
  const pid = options.pid ?? process.pid
  const resident = options.resident !== false
  const book = createTicketBook(store.db, store.root, now)
  const inflight = new Set<string>()
  /** @type {Map<string, { messageId: string, turn: number | null, seq: number | null }>} */
  const turns: Map<string, { messageId: string; turn: number | null; seq: number | null }> = new Map()
  /** @type {Map<string, string>} */
  const wakeTurns: Map<string, string> = new Map()
  /** @type {Map<string, { turn: number, startedAt: number, steps: number, tokens: number, lastSeq: number | null, role: 'main' | 'worker', tight: boolean, limits: { maxSteps: number, wallMs: number, maxTokens: number, ceilingWall: number, ceilingTokens: number }, tripped: boolean, extensionOpen: boolean, closing: boolean, clear: () => void }>} */
  const arms: Map<string, BudgetArm> = new Map()
  /** @type {Map<string, number>} */
  const holds: Map<string, number> = new Map()
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const deps = {
    pid,
    inflight,
    logHas: async (sessionId: string, messageId: string) => {
      if (!options.logHas) return false
      return await options.logHas(sessionId, messageId)
    },
    push: async (sessionId: string, messageId: string, text: string) => {
      if (!options.push) return { ok: false, ambiguous: true, error: 'no-push' }
      return options.push(sessionId, messageId, text)
    },
    noticeText: (nativeId: string) => noticeText(nativeId),
  }

  return {
    limits,
    book,
    dispatch,
    supply,
    redirect,
    cancelTicket,
    retry,
    grant,
    publish,
    reject,
    report,
    holdNotices,
    releaseHold,
    tick,
    admit,
    observeSession,
    observeClaimed,
    isWorkerSession,
    summaries: (owner: string) => book.summaries(owner),
    detail: (id: string) => book.detail(id),
    liveStamp: () => book.liveStamp(),
    liveBoard: (sessionId: string) => book.liveBoard(sessionId),
    liveBoardAll: () => book.liveBoardAll(),
    project,
  }

  /**
   * @param {string} sessionId
   */
  function isWorkerSession(sessionId: string) {
    return book.attemptForChild(sessionId) != null
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function dispatch(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner))
      return toolError('FORBIDDEN', 'An ordinary session stays on one loop and cannot dispatch work.')
    if (typeof args.parentTicketId === 'string' && args.parentTicketId !== '') {
      return toolError('VALIDATION', 'The MVP does not accept child tickets.')
    }
    const briefing = typeof args.briefing === 'string' ? args.briefing.trim() : ''
    if (briefing === '' || briefing.length > 16000) return toolError('VALIDATION', 'briefing is empty or too long.')
    const key =
      typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim() !== '' ? args.idempotencyKey.trim() : null
    const suggestion = args.budget && typeof args.budget === 'object' ? args.budget : null
    const budget = estimateWorkerBudget(briefing, suggestion, limits)
    const prepared = await store.write('work', () => {
      if (key) {
        const existing = book.byIdempotency(owner, key)
        if (existing) {
          if (existing.briefing_hash !== sha256(briefing))
            return {
              error: toolError('IDEMPOTENCY_KEY_REUSE', 'The same idempotency key was reused for a different task.'),
            }
          return { replay: existing }
        }
      }
      if (book.countActive(owner) >= limits.perBot || book.countGlobal() >= limits.global) {
        return {
          error: toolError(
            'BUDGET',
            'Unfinished tickets already hit the host concurrency limit, so no row was created.',
          ),
        }
      }
      return {
        created: book.insertAccepted({
          owner,
          briefing,
          idempotencyKey: key,
          correlationId: correlationOf(owner, args.correlationId),
          budget,
        }),
      }
    })
    if (prepared.error) return prepared.error
    if (prepared.replay) return publicDispatch(prepared.replay, { replayed: true })
    const ticket = prepared.created.ticket
    if (!resident) {
      return { ...publicDispatch(ticket), flush: 'pending', resident: false, message: 'Only a resident host continues' }
    }
    const created = await ensureChild(ticket)
    if (created.error) return created.error
    const input = await store.write('work', () => {
      const current = book.ticket(ticket.id)
      const attempt = book.attempt(current.active_attempt_id)
      if (attempt?.current_input_id) return book.input(attempt.current_input_id)
      return book.insertInput({
        ticketId: current.id,
        attemptId: attempt.id,
        revision: current.briefing_revision,
        kind: 'briefing',
        text: briefing,
      })
    })
    const flushed = await pushInput(book, input, deps)
    return publicDispatch(book.ticket(ticket.id), {
      flush: flushWord(flushed),
      nativeMessageId: input.native_message_id,
    })
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function supply(owner: string, args: Record<string, unknown>) {
    return retarget(owner, args, 'supply')
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function redirect(owner: string, args: Record<string, unknown>) {
    return retarget(owner, args, 'redirect')
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   * @param {'supply' | 'redirect'} kind
   */
  async function retarget(owner: string, args: Record<string, unknown>, kind: 'supply' | 'redirect') {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot change a ticket.')
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '' || text.length > 16000) return toolError('VALIDATION', 'text is empty or too long.')
    const found = resolveTicket(owner, args.ticketId, kind === 'supply' ? ['needs_user', 'enqueued'] : null)
    if (found.error) return found.error
    const expected = revisionOf(args.expectedRevision)
    const advanced = await store.write('work', () => book.advanceGeneration(found.ticket.id, expected, kind, text))
    if (advanced.error) return toolError(advanced.error, advanced.message ?? 'Changing the generation failed.')
    if (!resident)
      return { ...publicDispatch(advanced.ticket), flush: 'pending', message: 'Only a resident host continues' }
    const flushed = await pushInput(book, advanced.input, deps)
    return publicDispatch(book.ticket(found.ticket.id), {
      flush: flushWord(flushed),
      nativeMessageId: advanced.input.native_message_id,
    })
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function cancelTicket(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot cancel a ticket.')
    const found = resolveTicket(owner, args.ticketId, null)
    if (found.error) return found.error
    const note = typeof args.note === 'string' ? args.note.trim() : ''
    const expected = revisionOf(args.expectedRevision)
    const cancelled = await store.write('work', () => book.markCancelled(found.ticket.id, expected, note))
    if (cancelled.error) return toolError(cancelled.error, cancelled.message ?? 'Cancel failed.')
    const child = cancelled.ticket.child_session_id
    if (resident && child && options.cancel) {
      await options.cancel(child, { keepInbox: note !== '' })
    }
    if (resident && note !== '' && cancelled.input) await pushInput(book, cancelled.input, deps)
    await removeUnclaimed(owner, cancelled.ticket.id)
    return {
      ok: true,
      ticketId: cancelled.ticket.id,
      ticketStatus: cancelled.ticket.status,
      already: cancelled.already === true,
    }
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function grant(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot grant more budget.')
    const found = resolveTicket(owner, args.ticketId, null)
    if (found.error) return found.error
    if (args.deny === true) {
      const failed = await store.write('work', () => book.failRunning(found.ticket.id, 'grant-denied'))
      const child = failed?.child_session_id
      const state = child ? arms.get(child) : null
      if (state) {
        state.closing = true
        state.clear?.()
      }
      if (resident && child && options.cancel) await options.cancel(child, { keepInbox: false })
      return { ok: true, ticketId: found.ticket.id, ticketStatus: 'failed', denied: true }
    }
    const added = await store.write('work', () =>
      book.extendBudget(
        found.ticket.id,
        {
          wallMs: typeof args.wallMs === 'number' ? args.wallMs : undefined,
          maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        },
        { wallMs: limits.workerWallMs, maxTokens: limits.workerMaxTokens },
      ),
    )
    if (added.error) return toolError(added.error, added.message ?? 'No budget was added.')
    const child = added.ticket.child_session_id
    if (child) releaseArm(child, added.budget)
    return {
      ok: true,
      ticketId: added.ticket.id,
      ticketStatus: added.ticket.status,
      wallMs: added.budget.wallMs,
      maxTokens: added.budget.maxTokens,
    }
  }

  async function retry(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot retry a ticket.')
    const found = resolveTicket(owner, args.ticketId, ['failed', 'cancelled'])
    if (found.error) return found.error
    const expected = revisionOf(args.expectedRevision)
    const retried = await store.write('work', () => book.insertRetry(found.ticket.id, expected))
    if (retried.error) return toolError(retried.error, retried.message ?? 'Retry failed.')
    if (!resident)
      return { ...publicDispatch(retried.ticket), flush: 'pending', message: 'Only a resident host continues' }
    const ensured = await ensureChild(retried.ticket)
    if (ensured.error) return ensured.error
    const flushed = await pushInput(book, retried.input, deps)
    return publicDispatch(book.ticket(retried.ticket.id), {
      flush: flushWord(flushed),
      nativeMessageId: retried.input.native_message_id,
    })
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function publish(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot publish.')
    const resultEventId = args.resultEventId
    if (typeof resultEventId !== 'string' || resultEventId === '')
      return toolError('VALIDATION', 'resultEventId is required.')
    const text = args.text
    if (typeof text !== 'string' || text.trim() === '' || text.length > 16000)
      return toolError('VALIDATION', 'text is empty or too long.')
    const turn = args.turn == null ? null : String(args.turn)
    const saved = await store.write('work', () => {
      const event = book.event(resultEventId)
      if (!event) return toolError('NOT_FOUND', 'No such result.')
      const ticket = book.ticket(event.ticket_id)
      if (!ticket || ticket.owner_session_id !== owner)
        return toolError('FORBIDDEN', 'This result does not belong to this session.')
      if (ticket.review_status === 'rejected') return toolError('REJECTED', 'This candidate was already rejected.')
      if (event.kind !== 'result' || event.apply_status !== 'applied')
        return toolError('VALIDATION', 'The result has not finished reconciliation.')
      if (event.briefing_revision !== ticket.briefing_revision)
        return toolError('VALIDATION', 'The result generation is stale.')
      const attempt = book.attempt(ticket.active_attempt_id)
      if (!attempt || attempt.id !== event.attempt_id || attempt.fencing_token !== event.fencing_token) {
        return toolError('VALIDATION', 'The result execution generation has changed.')
      }
      if (ticket.status === 'cancelled' || ticket.status === 'failed')
        return toolError('VALIDATION', 'This ticket can no longer be published.')
      const delivery = book.insertDelivery({
        ticketId: ticket.id,
        eventId: event.event_id,
        owner,
        attemptId: attempt.id,
        fencingToken: attempt.fencing_token,
        briefingRevision: event.briefing_revision,
        text,
        turn,
      })
      return {
        ok: true,
        publishId: delivery.row.publish_id,
        already: delivery.already,
        text,
        status: delivery.row.status,
        ticketId: ticket.id,
      }
    })
    return saved
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function reject(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot reject a candidate.')
    const resultEventId = args.resultEventId
    if (typeof resultEventId !== 'string' || resultEventId === '')
      return toolError('VALIDATION', 'resultEventId is required.')
    return store.write('work', () => {
      const event = book.event(resultEventId)
      if (!event) return toolError('NOT_FOUND', 'No such result.')
      const ticket = book.ticket(event.ticket_id)
      if (!ticket || ticket.owner_session_id !== owner)
        return toolError('FORBIDDEN', 'This result does not belong to this session.')
      if (event.kind !== 'result' || event.apply_status !== 'applied')
        return toolError('VALIDATION', 'There is no candidate to reject yet.')
      book.setReview(ticket.id, 'rejected')
      store.db
        .prepare(`
        UPDATE user_deliveries SET status = 'abandoned'
        WHERE result_event_id = ? AND status = 'intent'
      `)
        .run(event.event_id)
      return { ok: true, reviewStatus: 'rejected', ticketId: ticket.id }
    })
  }

  /**
   * @param {string} sessionId child session
   * @param {Record<string, unknown>} args
   */
  async function report(sessionId: string, args: Record<string, unknown>) {
    const kind = typeof args.kind === 'string' ? args.kind : ''
    if (!KINDS.has(kind))
      return toolError('VALIDATION', 'kind must be progress, question, artifact, result, or failure.')
    const text = typeof args.text === 'string' ? args.text : ''
    if (text.trim() === '' || text.length > 16000) return toolError('VALIDATION', 'text is empty or too long.')
    const attempt = book.attemptForChild(sessionId)
    if (!attempt) return toolError('FORBIDDEN', 'This session is not a worker, so it cannot report.')
    const bound = turns.get(sessionId)
    if (!bound) return toolError('NOT_FOUND', 'This round has no matching briefing.')
    const input = book.inputByNative(bound.messageId)
    if (!input || input.attempt_id !== attempt.id) return toolError('NOT_FOUND', 'This round has no matching briefing.')
    const ticket = book.ticket(input.ticket_id)
    if (!ticket) return toolError('NOT_FOUND', 'The ticket does not exist.')
    const current =
      ticket.active_attempt_id === attempt.id &&
      ticket.briefing_revision === input.briefing_revision &&
      ticket.status !== 'cancelled' &&
      ticket.status !== 'failed' &&
      ticket.status !== 'delivered'
    const applyStatus =
      current && (kind === 'progress' || kind === 'artifact') ? 'applied' : current ? 'pending_completion' : 'stale'
    const saved = await store.write('work', () =>
      book.insertEvent({
        ticketId: ticket.id,
        attemptId: attempt.id,
        fencingToken: attempt.fencing_token,
        briefingRevision: input.briefing_revision,
        kind,
        text,
        applyStatus,
      }),
    )
    if (saved.duplicate || !saved.event) return toolError('REPLAY', 'This event was already written.')
    const until = new Date(now().getTime() + limits.leaseMs).toISOString()
    book.touchLease(attempt.id, until, typeof bound.seq === 'number' ? bound.seq : null)
    return {
      ok: true,
      eventId: saved.event.event_id,
      applyStatus: saved.event.apply_status,
      kind,
    }
  }

  async function tick() {
    await reconcileInputs(book, deps)
    await reconcileNotices(book, deps)
    await store.write('work', () => {
      book.expireQuiet()
    })
    for (const owner of book.ownerIds()) {
      if (engine.isBot(owner)) await admit(owner)
    }
    for (const child of book.childIds()) await reconcileChild(child)
    for (const owner of book.ownerIds()) await reconcileOwner(owner)
  }

  /**
   * @param {string} owner
   */
  async function admit(owner: string) {
    const wake = book.pendingWake(owner)
    if (wake.events.length === 0 && wake.cancels.length === 0) return { admitted: false, reason: 'empty' }
    let pending = null
    try {
      pending = options.pendingIds ? await options.pendingIds(owner) : null
    } catch {
      pending = null
    }
    const terminalTimes = []
    for (const event of wake.events) {
      if (
        (event.kind === 'question' || event.kind === 'result' || event.kind === 'failure') &&
        event.apply_status === 'applied'
      ) {
        terminalTimes.push(Date.parse(event.created_at))
      }
    }
    for (const ticket of wake.cancels) terminalTimes.push(Date.parse(ticket.updated_at))
    const heldUntil = holds.get(owner)
    if (heldUntil != null && now().getTime() < heldUntil) return { admitted: false, reason: 'interrupt-hold' }
    if (heldUntil != null) holds.delete(owner)
    const decision = decideAdmission({
      pendingIds: pending,
      backgroundIds: book.backgroundIds(owner),
      noticeOpen: book.openNotice(owner),
      deliveryOpen: book.openDelivery(owner),
      lastNoticeAt: book.latestNoticeAt(owner),
      nowMs: now().getTime(),
      mergeWindowMs: limits.mergeWindowMs,
      terminalSince: terminalTimes.length === 0 ? null : Math.min(...terminalTimes),
      starveMs: limits.starveMs,
    })
    if (!decision.admit) return { admitted: false, ...decision }
    const nativeId = randomUUID()
    const items: Array<{ ticketId: string; eventId: string; line: string }> = []
    for (const event of wake.events) {
      const ticket = book.ticket(event.ticket_id)
      if (!ticket) continue
      items.push({
        ticketId: ticket.id,
        eventId: event.event_id,
        line: noticeLine(ticket, event),
      })
    }
    for (const ticket of wake.cancels) {
      items.push({
        ticketId: ticket.id,
        eventId: `cancel:${ticket.cancel_requested_revision}`,
        line: `${ticket.id} cancelled rev ${ticket.briefing_revision}`,
      })
    }
    if (items.length === 0) return { admitted: false, reason: 'empty' }
    await store.write('work', () => {
      book.insertNotices(nativeId, owner, items)
    })
    const flushed = await pushNotice(book, nativeId, owner, renderNotice(items.map(item => item.line)), 0, deps)
    return { admitted: true, nativeMessageId: nativeId, flush: flushWord(flushed), ...decision }
  }

  /**
   * Progress stays a status line. Result and failure carry the body so the
   * main bot writes the user-visible reply instead of leaving it on the card.
   * @param {Record<string, any>} ticket
   * @param {Record<string, any>} event
   */
  function noticeLine(ticket: Record<string, any>, event: Record<string, any>) {
    const status = String(ticket.status)
    const head = `${ticket.id} ${status} (${LABEL[status] ?? status}) rev ${ticket.briefing_revision} ${event.kind}`
    const text = book.detail(ticket.id)?.events?.find(item => item.event_id === event.event_id)?.text ?? ''
    if (text.startsWith('[foundations:extension]')) {
      return [head, `eventId: ${event.event_id}`, text].join('\n')
    }
    if (event.kind !== 'result' && event.kind !== 'failure') return head
    const body = text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text
    const ask =
      event.kind === 'result'
        ? 'This is a successful result. Call foundations_publish now. Use the eventId below as resultEventId and the words you want the user to see as text. After the tool returns, write that same text as the reply to the user. Do not only restate the status, and do not ask the user to paste the body back.'
        : 'This is a failed result. Now tell the user the reason and the next step in your own words. Do not only restate the status, and do not ask the user to paste the body back.'
    return [head, `eventId: ${event.event_id}`, ask, '---', body].join('\n')
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, any>} event
   */
  function observeSession(sessionId: string, event: Record<string, any>) {
    if (!event || typeof event.type !== 'string') return
    noteBudget(sessionId, event)
    const nativeId = messageIdOf(event)
    if (
      (event.type === 'user/message' || event.type === 'agent/inbox/claimed') &&
      nativeId &&
      book.inputByNative(nativeId)
    ) {
      turns.set(sessionId, {
        messageId: nativeId,
        turn: event.data?.turn ?? null,
        seq: typeof event.seq === 'number' ? event.seq : null,
      })
    }
    if (event.type === 'user/message' && engine.isBot(sessionId)) holds.delete(sessionId)
    if (event.type === 'user/message' && nativeId) {
      const input = book.inputByNative(nativeId)
      if (input) {
        book.markStarted(input.ticket_id, nativeId)
        const attempt = book.attempt(input.attempt_id)
        if (attempt)
          book.touchLease(
            attempt.id,
            new Date(now().getTime() + limits.leaseMs).toISOString(),
            typeof event.seq === 'number' ? event.seq : null,
          )
      }
      if (engine.isBot(sessionId) && book.noticeIds(sessionId).has(nativeId)) {
        book.setNoticeObserve(nativeId, 'started')
        if (event.data?.turn != null) wakeTurns.set(`${sessionId}:${event.data.turn}`, nativeId)
      }
    }
    if (event.type === 'turn/end') applyTurnEnd(sessionId, event.data?.turn ?? null, reasonKindOf(event))
    if (isWorkerSession(sessionId) && typeof event.seq === 'number') {
      const attempt = book.attemptForChild(sessionId)
      if (attempt && (attempt.status === 'started' || attempt.status === 'enqueued')) {
        book.touchLease(attempt.id, new Date(now().getTime() + limits.leaseMs).toISOString(), event.seq)
      }
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} messageId
   * @param {number | null} turn
   */
  function observeClaimed(sessionId: string, messageId: string, turn: number | null) {
    if (book.inputByNative(messageId)) turns.set(sessionId, { messageId, turn, seq: null })
    book.setNoticeObserve(messageId, 'claimed')
  }

  /**
   * @param {Record<string, any>} ticket
   */
  async function ensureChild(ticket: Record<string, any>) {
    if (ticket.child_session_id) return { ticket }
    if (!options.createChild) return { error: publicDispatch(ticket, { flush: 'pending' }) }
    const sessionId = `worker-${ticket.id}`
    try {
      const created = await options.createChild({
        sessionId,
        ownerSessionId: ticket.owner_session_id,
        ticketId: ticket.id,
        fencingToken: book.attempt(ticket.active_attempt_id)?.fencing_token ?? 1,
      })
      const child = typeof created === 'string' && created !== '' ? created : sessionId
      engine.ensureSession(child)
      const saved = await store.write('work', () => book.setChildIfEmpty(ticket.id, child))
      return { ticket: saved }
    } catch {
      return {
        error: publicDispatch(book.ticket(ticket.id), {
          flush: 'pending',
          childSessionId: null,
          nativeMessageId: null,
        }),
      }
    }
  }

  /**
   * @param {string} owner
   * @param {unknown} ticketId
   * @param {string[] | null} statuses
   */
  function resolveTicket(owner: string, ticketId: unknown, statuses: string[] | null) {
    if (typeof ticketId === 'string' && ticketId !== '') {
      const ticket = book.ticket(ticketId)
      if (!ticket || ticket.owner_session_id !== owner) return { error: toolError('NOT_FOUND', 'No such ticket.') }
      return { ticket }
    }
    const rows = store.db
      .prepare(`
      SELECT * FROM work_tickets WHERE owner_session_id = ?
      ${statuses ? `AND status IN (${statuses.map(() => '?').join(',')})` : ''}
      ORDER BY updated_at DESC
    `)
      .all(owner, ...(statuses ?? []))
    if (rows.length !== 1) return { error: toolError('VALIDATION', 'Name the ticket.') }
    return { ticket: rows[0] }
  }

  /**
   * @param {unknown} value
   */
  function revisionOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null
  }

  /**
   * @param {string} owner
   * @param {unknown} value
   */
  function correlationOf(owner: string, value: unknown) {
    if (typeof value !== 'string' || value === '') return ''
    const found = store.db
      .prepare(`
      SELECT 1 AS ok FROM deliveries WHERE id = ? AND (sender_session_id = ? OR target_session_id = ?)
    `)
      .get(value, owner, owner)
    return found ? value : ''
  }

  /**
   * @param {Record<string, any>} ticket
   * @param {{ replayed?: boolean, flush?: string, nativeMessageId?: string | null, childSessionId?: string | null }} [extra]
   */
  function publicDispatch(
    ticket: Record<string, any>,
    extra: { replayed?: boolean; flush?: string; nativeMessageId?: string | null; childSessionId?: string | null } = {},
  ) {
    const fresh = book.ticket(ticket.id) ?? ticket
    const attempt = fresh.active_attempt_id ? book.attempt(fresh.active_attempt_id) : null
    const input = attempt ? book.currentInput(attempt) : null
    const flush =
      extra.flush ??
      (input?.flush_status === 'accepted'
        ? 'accepted'
        : input?.flush_status === 'ambiguous' || input?.flush_status === 'flushing'
          ? 'ambiguous'
          : 'pending')
    const dispatched =
      flush === 'accepted' || (fresh.status !== 'accepted' && fresh.status !== 'failed' && fresh.status !== 'cancelled')
    return {
      ok: true,
      ticketId: fresh.id,
      attemptId: attempt?.id ?? fresh.active_attempt_id,
      briefingRevision: fresh.briefing_revision,
      status: dispatched && flush === 'accepted' ? 'enqueued' : 'accepted',
      ticketStatus: fresh.status,
      childSessionId: extra.childSessionId === null ? null : fresh.child_session_id,
      fencingToken: attempt?.fencing_token ?? null,
      nativeMessageId: extra.nativeMessageId === undefined ? (input?.native_message_id ?? null) : extra.nativeMessageId,
      flush,
      replayed: extra.replayed === true,
    }
  }

  function project(ticket: Record<string, any>) {
    return publicDispatch(ticket)
  }

  /**
   * @param {{ status?: string }} flushed
   */
  function flushWord(flushed: { status?: string }) {
    if (flushed?.status === 'accepted') return 'accepted'
    if (flushed?.status === 'ambiguous') return 'ambiguous'
    return 'pending'
  }

  /**
   * @param {string} sessionId
   * @param {number | null} turn
   * @param {string} reason
   */
  function applyTurnEnd(sessionId: string, turn: number | null, reason: string) {
    const bound = turns.get(sessionId)
    if (engine.isBot(sessionId) && turn != null) {
      const nativeId = wakeTurns.get(`${sessionId}:${turn}`)
      if (nativeId) book.setNoticeObserve(nativeId, 'completed')
    }
    clearBudget(sessionId)
    if (!bound) return
    if (turn != null && bound.turn != null && bound.turn !== turn) return
    const input = book.inputByNative(bound.messageId)
    if (!input) return
    const found = book.detail(input.ticket_id)
    if (!found) return
    for (const event of found.events) {
      if (event.attempt_id !== input.attempt_id) continue
      if (event.briefing_revision !== input.briefing_revision) continue
      if (event.apply_status !== 'pending_completion') continue
      book.applyTerminal(event.event_id, reason)
    }
  }

  /**
   * @param {string} sessionId
   */
  async function reconcileChild(sessionId: string) {
    if (!options.snapshot) return
    const events = await options.snapshot(sessionId)
    /** @type {Map<number, string>} */
    const byTurn: Map<number, string> = new Map()
    for (const event of events) {
      const nativeId = messageIdOf(event)
      if (event.type === 'user/message' && nativeId && book.inputByNative(nativeId)) {
        const input = book.inputByNative(nativeId)
        book.markStarted(input.ticket_id, nativeId)
        turns.set(sessionId, {
          messageId: nativeId,
          turn: event.data?.turn ?? null,
          seq: typeof event.seq === 'number' ? event.seq : null,
        })
        if (event.data?.turn != null) byTurn.set(event.data.turn, nativeId)
      }
    }
    for (const event of events) {
      if (event.type !== 'turn/end') continue
      const nativeId = byTurn.get(event.data?.turn)
      if (!nativeId) continue
      turns.set(sessionId, { messageId: nativeId, turn: event.data?.turn ?? null, seq: null })
      const input = book.inputByNative(nativeId)
      if (!input) continue
      const found = book.detail(input.ticket_id)
      for (const item of found?.events ?? []) {
        if (item.apply_status === 'pending_completion' && item.briefing_revision === input.briefing_revision) {
          book.applyTerminal(item.event_id, reasonKindOf(event))
        }
      }
    }
  }

  /**
   * @param {string} owner
   */
  async function reconcileOwner(owner: string) {
    if (!options.snapshot) return
    const events = await options.snapshot(owner)
    const notices = book.noticeIds(owner)
    /** @type {string | null} */
    let waiting: string | null = null
    for (const event of events) {
      const name = event.data?.name ?? event.data?.toolName
      const args = parseArgs(event.data?.arguments ?? event.data?.args ?? event.data?.result)
      if (
        (event.type === 'tool/call' || event.type === 'tool/result') &&
        name === 'foundations_publish' &&
        typeof args?.resultEventId === 'string'
      ) {
        waiting = args.resultEventId
      }
      if (event.type === 'user/message' && notices.has(messageIdOf(event))) continue
      if (event.type === 'assistant/message' && waiting && typeof event.seq === 'number') {
        const ticketRows = book.ownerIds().includes(owner)
          ? store.db
              .prepare(`
          SELECT * FROM user_deliveries WHERE owner_session_id = ? AND result_event_id = ? AND status = 'intent'
        `)
              .get(owner, waiting)
          : null
        if (ticketRows) book.bindDelivery(ticketRows.publish_id, event.seq)
        waiting = null
      }
    }
  }

  /**
   * @param {string} nativeId
   */
  function noticeText(nativeId: string) {
    const rows = store.db.prepare(`SELECT * FROM work_notices WHERE native_message_id = ?`).all(nativeId)
    const lines = rows.map(row => {
      const ticket = book.ticket(row.ticket_id)
      return `${row.ticket_id} ${ticket?.status ?? ''} rev ${ticket?.briefing_revision ?? ''} ${row.event_id}`
    })
    return renderNotice(lines)
  }

  /**
   * @param {string} owner
   * @param {string} ticketId
   */
  async function removeUnclaimed(owner: string, ticketId: string) {
    const rows = store.db
      .prepare(`SELECT * FROM work_notices WHERE ticket_id = ? AND observe_status = 'none'`)
      .all(ticketId)
    const seen = new Set()
    for (const row of rows) {
      if (seen.has(row.native_message_id)) continue
      seen.add(row.native_message_id)
      if (row.flush_status === 'accepted' && options.remove) {
        await options.remove(owner, row.native_message_id)
      } else if (row.flush_status !== 'accepted') {
        book.markNoticeGroup(row.native_message_id, 'dead', row.flush_pid ?? null, 'cancelled', null, false)
      }
    }
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, any>} event
   */
  function noteBudget(sessionId: string, event: Record<string, any>) {
    const role = budgetRole(sessionId)
    if (!role) return
    if (role === 'main' && (event.type === 'tool/call' || event.type === 'tool/result')) {
      const name = event.data?.name ?? event.data?.toolName
      if (
        name === 'foundations_dispatch' ||
        (typeof name === 'string' && name !== '' && !name.startsWith('foundations_'))
      ) {
        tightenMain(sessionId)
      }
    }
    if (event.type === 'turn/start') {
      arm(sessionId, event.data?.turn ?? 0, role)
      return
    }
    const state = arms.get(sessionId)
    if (event.type === 'assistant/message' && role === 'worker' && state) {
      const seq = typeof event.seq === 'number' ? event.seq : null
      if (seq != null && state.lastSeq != null && seq <= state.lastSeq) return
      const total = event.data?.usage?.totalTokens
      if (typeof total === 'number' && total > 0) {
        state.tokens += total
        if (seq != null) state.lastSeq = seq
        consider(sessionId, state, false)
      }
      return
    }
    if (event.type !== 'step/end') return
    const live = state ?? arm(sessionId, event.data?.turn ?? 0, role)
    const step = Number(event.data?.step)
    live.steps = Number.isFinite(step) ? Math.max(live.steps, step) : live.steps + 1
    if (role === 'main') consider(sessionId, live, false)
  }

  /**
   * @param {string} sessionId
   */
  function budgetRole(sessionId: string) {
    if (book.attemptForChild(sessionId)) return 'worker'
    if (engine.isBot(sessionId)) return 'main'
    return null
  }

  /**
   * Keep ticket notices out of the inbox until the interrupting user message
   * arrives, or until the hold expires.
   * @param {string} sessionId
   */
  function holdNotices(sessionId: string) {
    if (!engine.isBot(sessionId)) return toolError('FORBIDDEN', 'Only a bot main session holds ticket notices.')
    const until = now().getTime() + limits.holdMs
    holds.set(sessionId, until)
    return { ok: true, until }
  }

  /**
   * @param {string} sessionId
   */
  function releaseHold(sessionId: string) {
    holds.delete(sessionId)
    return { ok: true }
  }

  /**
   * A dispatch or a host tool leaves the chat budget and uses the short cap.
   * @param {string} sessionId
   */
  function tightenMain(sessionId: string) {
    const state = arms.get(sessionId)
    if (!state || state.role !== 'main' || state.tight || state.closing || state.tripped) return
    state.tight = true
    state.limits = {
      ...state.limits,
      maxSteps: limits.mainMaxSteps,
      wallMs: limits.mainWallMs,
      ceilingWall: limits.mainWallMs,
    }
    state.clear?.()
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    state.clear = schedule(
      () => {
        const live = arms.get(sessionId)
        if (!live || live !== state || live.closing) return
        consider(sessionId, live, true)
      },
      Math.max(1, state.limits.wallMs - elapsed),
    )
    consider(sessionId, state, false)
  }

  /**
   * @param {string} sessionId
   * @param {number} turn
   * @param {'main' | 'worker'} role
   */
  function arm(sessionId: string, turn: number, role: 'main' | 'worker') {
    const previous = arms.get(sessionId)
    clearBudget(sessionId)
    const caps =
      role === 'main'
        ? {
            maxSteps: limits.chatMaxSteps,
            wallMs: limits.chatWallMs,
            maxTokens: Number.POSITIVE_INFINITY,
            ceilingWall: limits.chatWallMs,
            ceilingTokens: Number.POSITIVE_INFINITY,
            extensionOpen: false,
          }
        : workerCaps(sessionId)
    const state = {
      turn,
      startedAt: previous?.startedAt ?? now().getTime(),
      steps: 0,
      tokens: previous?.tokens ?? 0,
      lastSeq: previous?.lastSeq ?? null,
      role,
      tight: false,
      limits: caps,
      tripped: false,
      extensionOpen: false,
      closing: false,
      clear: () => {},
    }
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    state.extensionOpen = previous?.extensionOpen === true || caps.extensionOpen === true
    const target = state.extensionOpen ? caps.ceilingWall : caps.wallMs
    state.clear = schedule(
      () => {
        const live = arms.get(sessionId)
        if (!live || live !== state || live.closing) return
        consider(sessionId, live, true)
      },
      Math.max(1, target - elapsed),
    )
    arms.set(sessionId, state)
    return state
  }

  /**
   * @param {string} sessionId
   */
  function workerCaps(sessionId: string) {
    const attempt = book.attemptForChild(sessionId)
    const ticket = attempt ? book.ticket(attempt.ticket_id) : null
    let wallMs: number = limits.workerWallMs
    let maxTokens: number = limits.workerMaxTokens
    let extensionOpen = false
    if (ticket) {
      try {
        const parsed = JSON.parse(ticket.budget_json)
        if (Number.isFinite(parsed.wallMs)) wallMs = Math.min(limits.workerWallMs, Math.max(1000, parsed.wallMs))
        if (Number.isFinite(parsed.maxTokens))
          maxTokens = Math.min(limits.workerMaxTokens, Math.max(1000, parsed.maxTokens))
        extensionOpen = parsed.extension === 'open'
      } catch {
        /* host ceiling */
      }
    }
    return {
      maxSteps: Number.POSITIVE_INFINITY,
      wallMs,
      maxTokens,
      ceilingWall: limits.workerWallMs,
      ceilingTokens: limits.workerMaxTokens,
      extensionOpen,
    }
  }

  /**
   * @param {string} sessionId
   * @param {{ steps: number, startedAt: number, limits: { maxSteps: number, wallMs: number }, tripped: boolean, role: 'main' | 'worker' }} state
   * @param {boolean} fromTimer
   */
  function consider(sessionId: string, state: BudgetArm, fromTimer: boolean) {
    if (state.closing) return
    if (state.role === 'main') {
      const elapsed = fromTimer ? state.limits.wallMs : now().getTime() - state.startedAt
      const reason = budgetTrip({
        steps: state.steps,
        elapsedMs: elapsed,
        maxSteps: state.limits.maxSteps,
        wallMs: state.limits.wallMs,
      })
      if (!reason || state.tripped) return
      state.tripped = true
      Promise.resolve(options.cancel?.(sessionId, { keepInbox: true })).catch(() => {})
      return
    }
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    if (state.tokens >= state.limits.ceilingTokens || elapsed >= state.limits.ceilingWall) {
      finishWorker(
        sessionId,
        state,
        state.tokens >= state.limits.ceilingTokens && elapsed < state.limits.ceilingWall ? 'tokens' : 'wall',
      )
      return
    }
    if (state.extensionOpen) return
    const overWall = fromTimer || elapsed >= state.limits.wallMs
    const overTokens = state.tokens >= state.limits.maxTokens
    if (!overWall && !overTokens) return
    if (overWall && state.limits.wallMs < state.limits.ceilingWall) {
      askForQuota(sessionId, state, 'wall', elapsed)
      return
    }
    if (overTokens && state.limits.maxTokens < state.limits.ceilingTokens) {
      askForQuota(sessionId, state, 'tokens', elapsed)
      return
    }
    finishWorker(sessionId, state, overTokens ? 'tokens' : 'wall')
  }

  /**
   * @param {string} sessionId
   * @param {{ limits: { wallMs: number, maxTokens: number, ceilingWall: number }, tokens: number, startedAt: number, extensionOpen: boolean, closing: boolean, clear: () => void }} state
   * @param {'wall' | 'tokens'} reason
   * @param {number} elapsed
   */
  function askForQuota(sessionId: string, state: BudgetArm, reason: 'wall' | 'tokens', elapsed: number) {
    state.extensionOpen = true
    state.clear?.()
    watchHostCeiling(sessionId, state)
    const attempt = book.attemptForChild(sessionId)
    if (!attempt) return
    const ticket = book.ticket(attempt.ticket_id)
    if (!ticket || ticket.status === 'failed' || ticket.status === 'cancelled' || ticket.status === 'delivered') {
      finishWorker(sessionId, state, reason)
      return
    }
    const marked = book.markExtensionOpen(ticket.id)
    if (!marked || marked.already) return
    const text = [
      '[foundations:extension]',
      reason === 'tokens' ? 'The token budget is used up.' : 'The runtime is used up.',
      `elapsed ms: ${elapsed}`,
      `granted wall ms: ${state.limits.wallMs}`,
      `tokens used: ${state.tokens}`,
      `granted tokens: ${state.limits.maxTokens}`,
      'Do not mark the ticket failed. Call foundations_grant to add budget. wallMs and maxTokens are amounts to add. Pass deny=true to refuse the grant.',
    ].join('\n')
    book.insertEvent({
      ticketId: ticket.id,
      attemptId: attempt.id,
      fencingToken: attempt.fencing_token,
      briefingRevision: ticket.briefing_revision,
      kind: 'progress',
      text,
      applyStatus: 'applied',
    })
  }

  /**
   * After a quota request, the worker keeps running until the host ceiling.
   * An early timer is rearmed. It does not fail the ticket by itself.
   * @param {string} sessionId
   * @param {{ startedAt: number, limits: { ceilingWall: number }, closing: boolean, clear: () => void }} state
   */
  function watchHostCeiling(sessionId: string, state: BudgetArm) {
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    state.clear = schedule(
      () => {
        const live = arms.get(sessionId)
        if (!live || live !== state || live.closing) return
        const at = Math.max(0, now().getTime() - live.startedAt)
        if (at >= live.limits.ceilingWall) {
          finishWorker(sessionId, live, 'wall')
          return
        }
        watchHostCeiling(sessionId, live)
      },
      Math.max(1000, state.limits.ceilingWall - elapsed),
    )
  }

  /**
   * @param {string} sessionId
   * @param {{ closing: boolean, clear: () => void }} state
   * @param {string} reason
   */
  function finishWorker(sessionId: string, state: BudgetArm, reason: string) {
    if (state.closing) return
    state.closing = true
    state.clear?.()
    Promise.resolve(options.cancel?.(sessionId, { keepInbox: false })).catch(() => {})
    const attempt = book.attemptForChild(sessionId)
    if (attempt) book.failRunning(attempt.ticket_id, reason)
  }

  /**
   * @param {string} sessionId
   * @param {{ wallMs: number, maxTokens: number }} budget
   */
  function releaseArm(sessionId: string, budget: { wallMs: number; maxTokens: number }) {
    const state = arms.get(sessionId)
    if (!state || state.role !== 'worker' || state.closing) return
    state.extensionOpen = false
    state.limits.wallMs = budget.wallMs
    state.limits.maxTokens = budget.maxTokens
    state.clear?.()
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    state.clear = schedule(
      () => {
        const live = arms.get(sessionId)
        if (!live || live !== state || live.closing) return
        consider(sessionId, live, true)
      },
      Math.max(1, budget.wallMs - elapsed),
    )
    if (state.tokens >= budget.maxTokens || elapsed >= budget.wallMs) consider(sessionId, state, false)
  }

  /**
   * @param {string} sessionId
   */
  function clearBudget(sessionId: string) {
    const state = arms.get(sessionId)
    if (!state) return
    state.clear?.()
    arms.delete(sessionId)
  }
}

/**
 * @param {unknown} value
 */
function parseArgs(value: unknown) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
