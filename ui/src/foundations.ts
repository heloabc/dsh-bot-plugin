export interface FoundationsResult {
  status: number
  body: Record<string, unknown>
}

export async function foundations(path: string, options?: RequestInit): Promise<FoundationsResult> {
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', ...(options?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
}

export interface SessionSetup {
  name: string
  personaText: string
  fact: string
  targetSessionId: string
  message: string
  runAt: string
  timerNote: string
}

/** Which follow-up calls a filled new-session sheet should make. Empty optional fields are skipped. */
export function setupSteps(setup: SessionSetup): Array<'persona' | 'fact' | 'message' | 'timer'> {
  const steps: Array<'persona' | 'fact' | 'message' | 'timer'> = ['persona']
  if (setup.fact.trim() !== '') steps.push('fact')
  if (setup.targetSessionId !== '' && setup.message.trim() !== '') steps.push('message')
  if (setup.runAt.trim() !== '') steps.push('timer')
  return steps
}

/** datetime-local is the operator's clock. The host stores an absolute instant. */
export function localRunAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

export function foundationsError(body: Record<string, unknown>, fallback: string): string {
  return typeof body.message === 'string' && body.message !== '' ? body.message : fallback
}

const NAME_LINE = /^(?:Name|名字)\s*[:：]\s*(.+?)\s*$/i
const STYLE_LINE = /^(?:Style|风格)\s*[:：]\s*(.+?)\s*$/i
const TASK_LINE = /^(?:Task|任务)\s*[:：]\s*(.+?)\s*$/i

/** A leading `Name:` line is the assistant's name. A legacy CJK name label still counts. */
export function splitPersona(text: string): { name: string; body: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { name: '', body: '' }
  const lines = trimmed.split('\n')
  const match = NAME_LINE.exec(lines[0] ?? '')
  if (!match) return { name: '', body: trimmed }
  return { name: match[1] ?? '', body: lines.slice(1).join('\n').trim() }
}

/** Name, style, and task become the bot's own persona. Empty parts are left out. */
export function composeBotPersona(name: string, style: string, task: string): string {
  const lines: string[] = []
  if (name.trim() !== '') lines.push(`Name: ${name.trim()}`)
  if (style.trim() !== '') lines.push(`Style: ${style.trim()}`)
  if (task.trim() !== '') lines.push(`Task: ${task.trim()}`)
  return lines.join('\n\n')
}

/** Read the three bot lines back out of a stored persona. */
export function botFields(text: string): { name: string; style: string; task: string } {
  const fields = { name: '', style: '', task: '' }
  for (const line of text.split('\n')) {
    const name = NAME_LINE.exec(line)
    const style = STYLE_LINE.exec(line)
    const task = TASK_LINE.exec(line)
    if (name && fields.name === '') fields.name = name[1] ?? ''
    else if (style && fields.style === '') fields.style = style[1] ?? ''
    else if (task && fields.task === '') fields.task = task[1] ?? ''
  }
  return fields
}

/** Store the name where the context renderer can bind it to the assistant. */
export function composePersona(name: string, body: string): string {
  const split = splitPersona(body)
  const chosen = name.trim() || split.name
  if (chosen === '') return split.body
  return split.body === '' ? `Name: ${chosen}` : `Name: ${chosen}\n\n${split.body}`
}
