/** Present official ask_user_question calls as a transcript card, not a generic tool row. */
import { argsOf } from './activity.ts'
import type { ToolSegment } from './types.ts'

export const USER_QUESTION_TOOL = 'ask_user_question'

export function isUserQuestionTool(name: string) {
  return name.replace(/-/g, '_').toLowerCase() === USER_QUESTION_TOOL
}

export type UserQuestionOption = {
  label: string
  description: string
}

export type UserQuestionItem = {
  id: string
  question: string
  header: string
  options: UserQuestionOption[]
  multiSelect: boolean
  selected: string[]
  custom: string
  skipped: boolean
}

export type UserQuestionState = 'open' | 'answered' | 'aborted' | 'failed'

export type UserQuestionView = {
  callId: string
  state: UserQuestionState
  title: string
  questions: UserQuestionItem[]
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseOptions(value: unknown): UserQuestionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.label !== 'string') return []
    return [{ label: row.label, description: rawString(row.description) }]
  })
}

function parseQuestions(value: unknown): Array<Omit<UserQuestionItem, 'selected' | 'custom' | 'skipped'>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const question = rawString(row.question)
    if (!question) return []
    const id = rawString(row.id)
    return [
      {
        id: id === '' ? `question-${index + 1}` : id,
        question,
        header: rawString(row.header),
        options: parseOptions(row.options),
        multiSelect: row.multi_select === true || row.multiSelect === true,
      },
    ]
  })
}

function parseAnswers(raw: string): Map<string, { selected: string[]; custom: string }> {
  const map = new Map<string, { selected: string[]; custom: string }>()
  const parsed = argsOf(raw)
  const answers = Array.isArray(parsed.answers) ? parsed.answers : Array.isArray(parsed) ? parsed : []
  for (const item of answers) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = rawString(row.id)
    if (!id) continue
    const selected = Array.isArray(row.selected)
      ? row.selected.flatMap(value => (typeof value === 'string' ? [value] : []))
      : []
    map.set(id, { selected, custom: rawString(row.custom) })
  }
  return map
}

function isAborted(tool: ToolSegment) {
  const code = tool.errorCode ?? ''
  return /ASK_ABORTED|ABORT|CANCEL/i.test(code) || /aborted before the user answered/i.test(tool.result)
}

function isSettled(tool: ToolSegment) {
  return Boolean(tool.resultReceived || tool.result !== '' || tool.error || tool.errorCode)
}

export function userQuestionView(tool: ToolSegment): UserQuestionView | null {
  if (!isUserQuestionTool(tool.name)) return null
  const questions = parseQuestions(argsOf(tool.args).questions)
  const answers = parseAnswers(tool.result)
  const aborted = isAborted(tool)
  const settled = isSettled(tool)
  const failed = settled && tool.error && !aborted
  const state: UserQuestionState = !settled ? 'open' : aborted ? 'aborted' : failed ? 'failed' : 'answered'
  const items = questions.map(question => {
    const answer = answers.get(question.id)
    const selected = answer?.selected ?? []
    const custom = answer?.custom ?? ''
    return {
      ...question,
      selected,
      custom,
      skipped: state === 'answered' && selected.length === 0 && !custom,
    }
  })
  const title = items.find(item => item.header)?.header || items[0]?.question || tool.name
  return { callId: tool.callId, state, title, questions: items }
}
