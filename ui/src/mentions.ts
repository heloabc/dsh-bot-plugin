export interface MentionTarget {
  sessionId: string
  label: string
}

export interface MentionQuery {
  start: number
  query: string
}

/** The @ being typed, only at the start of the draft or after whitespace. */
export function mentionQuery(text: string, cursor: number): MentionQuery | null {
  const safe = Math.max(0, Math.min(cursor, text.length))
  const match = /(?:^|\s)@([^\s@()]*)$/.exec(text.slice(0, safe))
  if (!match || match.index == null) return null
  const query = match[1] ?? ''
  return { start: match.index + match[0].length - query.length - 1, query }
}

/** Keep the token in the form the system prompt tells the model to read. */
export function mentionLabel(label: string): string {
  const cleaned = label
    .replace(/[@()\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Untitled'
}

export function mentionToken(label: string, sessionId: string): string {
  return `@${mentionLabel(label)} (${sessionId})`
}

export function insertMention(
  text: string,
  cursor: number,
  start: number,
  label: string,
  sessionId: string,
): { text: string; cursor: number } {
  const safe = Math.max(0, Math.min(cursor, text.length))
  const token = `${mentionToken(label, sessionId)} `
  return {
    text: text.slice(0, start) + token + text.slice(safe),
    cursor: start + token.length,
  }
}

export function filterMentions(targets: readonly MentionTarget[], query: string): MentionTarget[] {
  const needle = query.trim().toLowerCase()
  return targets
    .filter(item => {
      if (needle === '') return true
      return item.label.toLowerCase().includes(needle) || item.sessionId.toLowerCase().includes(needle)
    })
    .slice(0, 8)
}
