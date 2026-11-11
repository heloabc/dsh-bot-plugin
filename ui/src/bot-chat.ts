import { parseBotMail, type BotMail } from './bot-message.ts'
import type { Segment } from './types.ts'

export type BotExchangeItem =
  | { kind: 'in'; id: string; seq: number; time?: number; mail: BotMail }
  | { kind: 'out'; id: string; seq: number; time?: number; text: string; target: string; correlation: string }

export interface InboxSummary {
  who: string
  preview: string
  count: number
}

const SEND_TOOLS = new Set(['foundations_send', 'foundations_reply'])

/** Bot-to-bot turns, in log order. Inbound mail and send/reply tool calls only. */
export function botExchange(segments: readonly Segment[]): BotExchangeItem[] {
  const items: BotExchangeItem[] = []
  for (const segment of segments) {
    if (segment.kind === 'user') {
      const mail = parseBotMail(segment.text)
      if (!mail) continue
      items.push({ kind: 'in', id: segment.id, seq: segment.seq, time: segment.time, mail })
      continue
    }
    if (segment.kind !== 'tool' || !SEND_TOOLS.has(segment.name)) continue
    const sent = outboundOf(segment)
    if (sent) items.push(sent)
  }
  items.sort((a, b) => a.seq - b.seq || (a.kind === b.kind ? 0 : a.kind === 'in' ? -1 : 1))
  return items
}

/**
 * Main transcript keeps inbox mail in place as its own line.
 * A send stays here until an inbox message exists, then it moves into the bot chat.
 */
export function mainSegments(segments: readonly Segment[]): Segment[] {
  const exchange = botExchange(segments)
  const hasInbox = exchange.some(item => item.kind === 'in')
  if (!hasInbox) return segments.slice()
  const hidden = new Set(exchange.filter(item => item.kind === 'out').map(item => item.id))
  return segments.filter(segment => !hidden.has(segment.id))
}

/** Latest inbound mail, for the entry beside the main chat. */
export function inboxSummary(
  items: readonly BotExchangeItem[],
  label: (sessionId: string) => string,
): InboxSummary | null {
  const inbound = items.filter((item): item is Extract<BotExchangeItem, { kind: 'in' }> => item.kind === 'in')
  const latest = inbound.at(-1)
  if (!latest) return null
  const preview = latest.mail.body.replace(/\s+/g, ' ').trim()
  return {
    who: label(latest.mail.from) || 'BOT',
    preview: preview.length > 72 ? `${preview.slice(0, 71)}…` : preview,
    count: inbound.length,
  }
}

/** Who an outbound line was sent to. A reply borrows the earlier inbound sender. */
export function outboundPeer(
  item: Extract<BotExchangeItem, { kind: 'out' }>,
  items: readonly BotExchangeItem[],
): string {
  if (item.target) return item.target
  if (!item.correlation) return ''
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const other = items[index]
    if (!other || other.seq > item.seq) continue
    if (other.kind === 'in' && other.mail.correlation === item.correlation) return other.mail.from
  }
  return ''
}

function outboundOf(segment: Extract<Segment, { kind: 'tool' }>): Extract<BotExchangeItem, { kind: 'out' }> | null {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(segment.args) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
  if (!text) return null
  return {
    kind: 'out',
    id: segment.id,
    seq: segment.seq,
    text,
    target: typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId : '',
    correlation: typeof parsed.correlationId === 'string' ? parsed.correlationId : '',
  }
}
