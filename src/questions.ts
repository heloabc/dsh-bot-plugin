/**
 * Official ask_user_question answerer for the desk UI.
 *
 * Open calls can be completed only by returning from the
 * `user-questions/request` waterfall. `userQuestions.answer` is only for
 * continued (timed/pending) questions. This listener is prepended so the
 * typpert `$events` remote answerer cannot intercept the request before the
 * desk can submit it. The official blocking legacy tool does not set
 * `wait.callId`; timed requests do.
 */
import { toolError, type ToolPayload } from './errors.ts'
import type { HostContext } from './host.ts'

export type OfficialQuestionOption = {
  label: string
  description?: string
}

export type OfficialQuestionItem = {
  id: string
  question: string
  detail?: string
  header?: string
  options?: OfficialQuestionOption[]
  multiSelect?: boolean
}

export type OfficialAnswerItem = {
  id: string
  selected: string[]
  custom?: string
}

export type OfficialAnswer = {
  answers: OfficialAnswerItem[]
}

export type OfficialQuestionRequest = {
  questions: OfficialQuestionItem[]
  agent?: { id?: unknown; session?: unknown }
  signal?: AbortSignal
  wait?: { callId?: unknown; timed?: boolean }
}

export type SubmitQuestionInput = {
  sessionId: string
  callId?: string
  answers: OfficialAnswerItem[]
}

type PendingQuestion = {
  request: OfficialQuestionRequest
  sessionId: string
  callId: string | undefined
  next: () => Promise<OfficialAnswer>
  resolve: (answer: OfficialAnswer) => void
  reject: (error: unknown) => void
  onAbort?: () => void
}

const answerers: Map<string, QuestionAnswerer> = new Map()

export function publishQuestionAnswerer(dataDir: string, answerer: QuestionAnswerer | null) {
  if (answerer) answerers.set(dataDir, answerer)
  else answerers.delete(dataDir)
}

export function questionAnswererFor(dataDir: string) {
  return answerers.get(dataDir) ?? null
}

export function abortedQuestion(cause?: unknown) {
  const error = new Error(
    'ask_user_question was aborted before the user answered',
    cause === undefined ? undefined : { cause },
  )
  ;(error as Error & { code: string }).code = 'ASK_ABORTED'
  return error
}

export function sessionIdOf(agent: OfficialQuestionRequest['agent']): string {
  if (!agent || typeof agent !== 'object') return ''
  if (typeof agent.session === 'string' && agent.session !== '') return agent.session
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  return ''
}

export function callIdOf(request: OfficialQuestionRequest): string | undefined {
  const callId = request.wait?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

function sameIds(questions: OfficialQuestionItem[], answers: OfficialAnswerItem[]) {
  if (questions.length !== answers.length) return false
  const ids = new Set(answers.map(item => item.id))
  return ids.size === answers.length && questions.every(item => ids.has(item.id))
}

/**
 * Build the official answer batch from a desk submission, preserving exact
 * question ids and option labels. Does not invent answers.
 */
export function officialAnswerFrom(
  questions: OfficialQuestionItem[],
  submitted: OfficialAnswerItem[],
): { ok: true; answer: OfficialAnswer } | { ok: false; code: string; message: string } {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, code: 'VALIDATION', message: 'A question request is required.' }
  }
  if (!Array.isArray(submitted)) {
    return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
  }
  const answers: OfficialAnswerItem[] = []
  const seen = new Set<string>()
  for (const item of submitted) {
    if (!item || typeof item !== 'object') {
      return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
    }
    if (typeof item.id !== 'string' || item.id === '' || seen.has(item.id)) {
      return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
    }
    const question = questions.find(entry => entry.id === item.id)
    if (!question) {
      return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
    }
    if (!Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string')) {
      return { ok: false, code: 'BAD_ANSWER', message: 'Each answer must include a selected label array.' }
    }
    const options = question.options ?? []
    for (const label of item.selected) {
      if (options.length === 0 || !options.some(option => option.label === label)) {
        return { ok: false, code: 'BAD_ANSWER', message: 'A selected label is not one of the offered options.' }
      }
    }
    if (question.multiSelect !== true && item.selected.length > 1) {
      return { ok: false, code: 'BAD_ANSWER', message: 'This question does not allow more than one selected option.' }
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      return { ok: false, code: 'BAD_ANSWER', message: 'A custom answer must be a string.' }
    }
    const custom = typeof item.custom === 'string' ? item.custom : undefined
    if (question.multiSelect !== true && custom !== undefined && custom !== '' && item.selected.length > 0) {
      return {
        ok: false,
        code: 'BAD_ANSWER',
        message: 'A single-select custom answer must leave selected empty.',
      }
    }
    seen.add(item.id)
    const entry: OfficialAnswerItem = { id: item.id, selected: [...item.selected] }
    if (custom !== undefined && custom !== '') entry.custom = custom
    answers.push(entry)
  }
  if (!sameIds(questions, answers)) {
    return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
  }
  return { ok: true, answer: { answers } }
}

function matchPending(
  pending: Iterable<PendingQuestion>,
  sessionId: string,
  callId: string | undefined,
  questionIds: string[],
) {
  const sessionRows = [...pending].filter(entry => entry.sessionId === sessionId)
  if (callId) {
    const byCall = sessionRows.filter(entry => entry.callId === callId)
    if (byCall.length === 1) return { ok: true as const, entry: byCall[0]! }
    if (byCall.length > 1) {
      return { ok: false as const, code: 'CONFLICT', message: 'Multiple open questions match this call.' }
    }
  }
  const byQuestions = sessionRows.filter(entry => {
    if (entry.callId && callId && entry.callId !== callId) return false
    const ids = entry.request.questions.map(question => question.id)
    return (
      ids.length === questionIds.length &&
      ids.every((id, index) => id === questionIds[index] || questionIds.includes(id)) &&
      questionIds.every(id => ids.includes(id))
    )
  })
  if (byQuestions.length === 1) return { ok: true as const, entry: byQuestions[0]! }
  if (byQuestions.length > 1) {
    return { ok: false as const, code: 'CONFLICT', message: 'Multiple open questions match this session.' }
  }
  return { ok: false as const, code: 'NOT_FOUND', message: 'No open user-questions request matches this session.' }
}

/** Structural official answer batch. Option membership is checked only against an open request. */
export function wellFormedAnswerBatch(
  submitted: OfficialAnswerItem[],
): { ok: true; answer: OfficialAnswer } | { ok: false; code: string; message: string } {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
  }
  const answers: OfficialAnswerItem[] = []
  const seen = new Set<string>()
  for (const item of submitted) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '' || seen.has(item.id)) {
      return { ok: false, code: 'BAD_ANSWER', message: 'The answer batch must name each question exactly once.' }
    }
    if (!Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string')) {
      return { ok: false, code: 'BAD_ANSWER', message: 'Each answer must include a selected label array.' }
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      return { ok: false, code: 'BAD_ANSWER', message: 'A custom answer must be a string.' }
    }
    seen.add(item.id)
    const entry: OfficialAnswerItem = { id: item.id, selected: [...item.selected] }
    if (typeof item.custom === 'string' && item.custom !== '') entry.custom = item.custom
    answers.push(entry)
  }
  return { ok: true, answer: { answers } }
}

export type QuestionAnswerer = ReturnType<typeof createQuestionAnswerer>

export function createQuestionAnswerer() {
  const pending = new Set<PendingQuestion>()
  let host: HostContext | null = null

  function detach(entry: PendingQuestion) {
    if (!pending.has(entry)) return false
    pending.delete(entry)
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort)
    }
    return true
  }

  function delegate(entry: PendingQuestion) {
    if (!detach(entry)) return
    Promise.resolve().then(entry.next).then(entry.resolve, entry.reject)
  }

  function waitForAnswer(
    request: OfficialQuestionRequest,
    next: () => Promise<OfficialAnswer>,
  ): Promise<OfficialAnswer> {
    const sessionId = sessionIdOf(request.agent)
    if (sessionId === '') return next()
    return new Promise((resolve, reject) => {
      const entry: PendingQuestion = {
        request,
        sessionId,
        callId: callIdOf(request),
        next,
        resolve,
        reject,
      }
      const onAbort = () => {
        if (!detach(entry)) return
        reject(abortedQuestion())
      }
      entry.onAbort = onAbort
      pending.add(entry)
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function handle(request: OfficialQuestionRequest, next: () => Promise<OfficialAnswer>) {
    return waitForAnswer(request, next)
  }

  function submitOpen(input: SubmitQuestionInput): ToolPayload | null {
    const questionIds = input.answers.map(item => item.id)
    const matched = matchPending(pending, input.sessionId, input.callId, questionIds)
    if (!matched.ok) {
      if (matched.code === 'CONFLICT') return toolError(matched.code, matched.message)
      return null
    }
    const built = officialAnswerFrom(matched.entry.request.questions, input.answers)
    if (!built.ok) return toolError(built.code, built.message)
    if (!detach(matched.entry)) return toolError('CONFLICT', 'This question was already answered.')
    matched.entry.resolve(built.answer)
    return { ok: true, path: 'open', answer: built.answer }
  }

  function submitContinued(input: SubmitQuestionInput): ToolPayload {
    const userQuestions = host?.userQuestions
    const agents = host?.agents
    if (!userQuestions || !agents) {
      return toolError('NOT_FOUND', 'No open user-questions request matches this session.')
    }
    const callId = input.callId
    if (typeof callId !== 'string' || callId === '') {
      return toolError('VALIDATION', 'callId is required to answer a continued question.')
    }
    const shaped = wellFormedAnswerBatch(input.answers)
    if (!shaped.ok) return toolError(shaped.code, shaped.message)
    const agent = agents.get(input.sessionId)
    if (!agent) return toolError('NOT_FOUND', 'No live agent is available for this session.')
    const agentSession = sessionIdOf(agent)
    if (agentSession !== '' && agentSession !== input.sessionId) {
      return toolError('FORBIDDEN', 'The answer does not belong to this session.')
    }
    try {
      const accepted = userQuestions.answer(agent, callId, shaped.answer)
      if (!accepted) return toolError('NOT_FOUND', 'This question is not a continued user-questions call.')
      return { ok: true, path: 'continued', answer: shaped.answer }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNAVAILABLE'
      const message = error instanceof Error ? error.message : 'The continued question could not be answered.'
      if (code === 'BAD_ANSWER') return toolError('BAD_ANSWER', message)
      if (code === 'REPLY_QUEUED') return toolError('CONFLICT', message)
      if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') return toolError('FORBIDDEN', message)
      return toolError(code, message)
    }
  }

  function submit(input: SubmitQuestionInput): ToolPayload {
    if (typeof input.sessionId !== 'string' || input.sessionId === '') {
      return toolError('VALIDATION', 'sessionId is required.')
    }
    const sessionId = input.sessionId
    const callId = typeof input.callId === 'string' && input.callId !== '' ? input.callId : undefined
    const answers = Array.isArray(input.answers) ? input.answers : null
    if (!answers) return toolError('VALIDATION', 'answers is required.')
    const open = submitOpen({ sessionId, callId, answers })
    if (open) return open
    return submitContinued({ sessionId, callId, answers })
  }

  function listen(ctx: HostContext) {
    host = ctx
    const dispose = ctx.on?.('user-questions/request', handle, true)
    return () => {
      if (typeof dispose === 'function') dispose()
      for (const entry of [...pending]) delegate(entry)
      if (host === ctx) host = null
    }
  }

  return {
    listen,
    handle,
    submit,
    pendingCount() {
      return pending.size
    },
  }
}
