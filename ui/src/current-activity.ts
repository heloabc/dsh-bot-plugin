import { OPEN_TOOL_STATES, redactText, toolPresentation, type ToolStatus } from './activity.ts'
import type { Segment } from './types.ts'
import type { WorkTicket } from './work.ts'

export interface CurrentActivityInput {
  segments: readonly Segment[]
  drafting: boolean
  currentTurn?: number | null
  tickets?: readonly WorkTicket[]
  connectionPhase?: string
  zh?: boolean
}

export interface ActivitySummary {
  text: string
  moving: boolean
}

const OPEN_TICKETS = new Set(['accepted', 'enqueued', 'started', 'needs_user', 'ready'])
const SETTLED_TICKETS = new Set(['delivered', 'failed', 'cancelled'])

/** A read-only summary, never a second transcript or evidence of process liveness. */
export function currentActivity(input: CurrentActivityInput): ActivitySummary | null {
  const { segments, drafting, currentTurn, tickets = [], zh = false } = input
  const unresolved: ActivitySummary[] = []
  const lastKnown: ActivitySummary[] = []
  const representedTickets = new Set<string>()
  const inCurrentTurn = (turn?: number) => currentTurn == null || turn === currentTurn
  const toolLabel = (state: ToolStatus) => {
    switch (state) {
      case 'preparing':
        return zh ? '准备调用' : 'Preparing call'
      case 'running':
        return zh ? '执行中（已确认）' : 'Running (confirmed)'
      case 'background':
        return zh ? '后台任务（最后已知）' : 'Background job (last known)'
      case 'worker':
        return zh ? '等待 Worker' : 'Waiting for Worker'
      default:
        return zh ? '等待工具结果' : 'Waiting for tool result'
    }
  }
  for (const segment of segments) {
    if (segment.kind !== 'tool') continue
    const view = toolPresentation(segment, undefined, tickets)
    if (view.status === 'worker' && view.ticket) continue // Count the linked worker once below, not once per dispatch call.
    if (view.status === 'worker' && view.ticketId) {
      if (representedTickets.has(view.ticketId)) continue
      representedTickets.add(view.ticketId)
    }
    const detail = view.description || view.command || view.title
    const item = { text: `${toolLabel(view.status)}: ${detail}`, moving: view.status !== 'background' }
    if (view.status === 'background') {
      // Last-known is not completion, but it is also not current pending work after the turn settles.
      if (drafting && inCurrentTurn(segment.turn)) lastKnown.push(item)
      continue
    }
    if (!OPEN_TOOL_STATES.has(view.status)) continue
    if (!drafting || !inCurrentTurn(segment.turn)) continue
    unresolved.push(item)
  }
  for (const ticket of tickets) {
    if (representedTickets.has(ticket.id) || SETTLED_TICKETS.has(ticket.status) || !OPEN_TICKETS.has(ticket.status))
      continue
    representedTickets.add(ticket.id)
    let label: string
    switch (ticket.status) {
      case 'accepted':
      case 'enqueued':
        label = zh ? '等待 Worker 调度' : 'Waiting for Worker scheduling'
        break
      case 'started':
        label = zh ? '等待 Worker' : 'Waiting for Worker'
        break
      case 'needs_user':
        label = zh ? '等待用户' : 'Waiting for you'
        break
      case 'ready':
        label = zh ? 'Worker 已返回，待确认' : 'Worker returned; awaiting review'
        break
      default:
        continue
    }
    unresolved.push({
      text: `${label}: ${ticket.summary}`,
      moving: ['accepted', 'enqueued', 'started'].includes(ticket.status),
    })
  }
  let summary = unresolved.at(-1)
  if (unresolved.length > 1 && summary) {
    summary = {
      text: `${zh ? `${unresolved.length} 项待完成活动` : `${unresolved.length} pending activities`} · ${summary.text}`,
      moving: unresolved.some(item => item.moving),
    }
  }
  if (!summary && lastKnown.length) summary = lastKnown.at(-1)
  if (!summary && drafting) {
    const current = segments.filter(item => inCurrentTurn(item.turn))
    summary = current.some(item => item.kind === 'think' && item.running)
      ? { text: zh ? '思考中' : 'Thinking', moving: true }
      : current.some(item => item.kind === 'assistant' && item.streaming)
        ? { text: zh ? '正在回复' : 'Replying', moving: true }
        : { text: zh ? '等待模型响应' : 'Waiting for model response', moving: true }
  }
  if (!summary) return null
  if (input.connectionPhase && input.connectionPhase !== 'live') {
    const syncing = ['restoring', 'connecting', 'syncing'].includes(input.connectionPhase)
    summary = {
      text: `${syncing ? (zh ? '正在同步' : 'Syncing') : zh ? '连接不可用' : 'Connection unavailable'} · ${zh ? '最后已知' : 'last known'}: ${summary.text}`,
      moving: false,
    }
  }
  return { ...summary, text: redactText(summary.text).replace(/\s+/g, ' ').trim() }
}
