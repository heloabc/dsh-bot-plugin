import { useId, useState, type ReactNode } from 'react'
import { Collapse } from './Collapse'
import { fileChange, type ActivitySegment, type FileChange } from './follow'
import { OPEN_TOOL_STATES, isShell, redactText, statusLabel, toolPresentation } from './activity'
import { useI18n } from './locale'
import type { WorkTicket } from './work'
import { type ThinkSegment, type ToolSegment } from './types'

export function ThinkRow({ segment }: { segment: ThinkSegment }) {
  const [open, setOpen] = useState(false)
  const { locale } = useI18n()
  return (
    <div className="official-row" data-variant="think" data-segment={segment.id}>
      <button type="button" className="official-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="official-leading">
          <ThinkIcon />
          <Chevron />
        </span>
        <span className="official-label">
          {locale === 'zh' ? (segment.running ? '思考中' : '思考记录') : segment.running ? 'Thinking' : 'Reasoning'}
        </span>
      </button>
      <Collapse open={open}>
        <div className="think-body">{redactText(segment.text)}</div>
      </Collapse>
    </div>
  )
}

/** One contiguous activity run in the timeline, shared by normal and Bot mode. No generic Thinking wrapper. */
export function ActivityGroup({
  segments,
  pending = false,
  tickets = [],
  cwd,
  connectionPhase,
}: {
  segments: ActivitySegment[]
  pending?: boolean
  tickets?: readonly WorkTicket[]
  cwd?: string
  connectionPhase?: string
}) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const active =
    pending ||
    segments.some(s =>
      s.kind === 'think' ? s.running : OPEN_TOOL_STATES.has(toolPresentation(s, cwd, tickets).status),
    )
  const states = segments
    .filter((s): s is ToolSegment => s.kind === 'tool')
    .map(s => toolPresentation(s, cwd, tickets).status)
  const counts = [
    [zh ? '活动中' : 'Active', states.filter(state => OPEN_TOOL_STATES.has(state)).length],
    [zh ? '失败' : 'Failed', states.filter(state => state === 'failed').length],
    [zh ? '取消' : 'Cancelled', states.filter(state => state === 'cancelled').length],
    [zh ? '未知' : 'Unknown', states.filter(state => state === 'unknown').length],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ')
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const open = expanded ?? active
  const stale = connectionPhase != null && connectionPhase !== 'live'
  return (
    <section
      className={open ? 'activity-group open' : 'activity-group'}
      aria-label={zh ? '活动' : 'Activity'}
      data-state={active ? 'running' : 'settled'}
      data-activity-start={segments[0]?.id}
    >
      <button type="button" className="official-title" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <span className="official-leading">
          <ToolIcon />
          <Chevron />
        </span>
        <span className="official-label">
          {zh ? '活动' : 'Activity'} · {segments.length}
        </span>
        {counts ? <span className="activity-status">{counts}</span> : null}
        {stale ? (
          <span className="activity-status">
            {['restoring', 'connecting', 'syncing'].includes(connectionPhase ?? '')
              ? zh
                ? '正在恢复同步 · 最后已知状态'
                : 'Resyncing · last known state'
              : zh
                ? '连接不可用 · 最后已知状态'
                : 'Connection unavailable · last known state'}
          </span>
        ) : null}
      </button>
      <Collapse open={open}>
        <div className="activity-body">
          {pending &&
          !segments.some(s =>
            s.kind === 'think' ? s.running : OPEN_TOOL_STATES.has(toolPresentation(s, cwd, tickets).status),
          ) ? (
            <p className="activity-note">
              {zh ? '正在生成回复；尚无新的工具执行证据' : 'Generating response; no new tool execution evidence'}
            </p>
          ) : null}
          {segments.map(segment =>
            segment.kind === 'think' ? (
              <ThinkRow key={segment.id} segment={segment} />
            ) : (
              <ToolCallRow key={segment.callId} segment={segment} cwd={cwd} tickets={tickets} stale={stale} />
            ),
          )}
        </div>
      </Collapse>
    </section>
  )
}

interface ToolRowProps {
  segment: ToolSegment
  cwd?: string
  tickets?: readonly WorkTicket[]
  stale?: boolean
}

export function ToolCallRow(props: ToolRowProps) {
  const [open, setOpen] = useState(false)
  const [argsOpen, setArgsOpen] = useState(false)
  return (
    <ToolCallRowView
      {...props}
      open={open}
      argsOpen={argsOpen}
      onToggle={() => setOpen(value => !value)}
      onArgsToggle={() => setArgsOpen(value => !value)}
    />
  )
}

/** Controlled presentation also keeps expanded-content SSR tests independent of default state. */
export function ToolCallRowView({
  segment,
  cwd,
  tickets = [],
  stale = false,
  open,
  argsOpen,
  onToggle,
  onArgsToggle,
}: ToolRowProps & { open: boolean; argsOpen: boolean; onToggle: () => void; onArgsToggle: () => void }) {
  const id = useId()
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const view = toolPresentation(segment, cwd, tickets)
  // The diff presenter receives only sanitized inputs too.
  const change = fileChange({ ...segment, args: view.args, result: view.output })
  const fallback = isShell(segment.name) ? (zh ? '执行命令' : 'Run command') : view.title
  const title =
    view.description ||
    (view.todos.length ? (zh ? '更新计划' : 'Update plan') : '') ||
    (view.ticket ? redactText(view.ticket.summary) : '') ||
    change?.name ||
    fallback
  const exceptional = ['failed', 'cancelled', 'unknown'].includes(view.status)
  return (
    <ActivityDisclosure
      className="official-row tool-activity"
      status={view.status}
      segmentId={segment.id}
      open={open}
      onToggle={onToggle}
      panelId={`${id}-tool`}
      title={
        <>
          <span className="official-leading">
            <ToolIcon />
            <Chevron />
          </span>
          <span className="official-label">{title}</span>
          {exceptional ? (
            <span className="activity-status">
              {statusLabel(view.status, zh)}
              {stale ? (zh ? ' · 最后已知' : ' · last known') : ''}
            </span>
          ) : null}
        </>
      }
    >
      <div className="activity-detail">
        {view.status !== 'succeeded' && !exceptional ? (
          <p className="activity-note">
            {statusLabel(view.status, zh)}
            {stale ? (zh ? ' · 最后已知' : ' · last known') : ''}
          </p>
        ) : null}
        {view.todos.length ? (
          <p className="activity-note">
            {view.todos.filter(todo => todo.status === 'completed').length}/{view.todos.length}{' '}
            {zh ? '项完成（计划记录）' : 'complete (plan record)'}
          </p>
        ) : null}
        <div className="activity-facts">
          {view.title} · {redactText(segment.callId)}
        </div>
        {view.command ? (
          <div className="activity-command">
            <CopyButton text={view.command} />
            <pre>{view.command}</pre>
          </div>
        ) : null}
        {view.cwd ? (
          <p className="activity-facts">
            {view.cwdSource === 'recorded'
              ? zh
                ? '执行记录目录'
                : 'Recorded working directory'
              : view.cwdSource === 'requested'
                ? zh
                  ? '请求目录'
                  : 'Requested working directory'
                : zh
                  ? '会话默认目录（非执行确认）'
                  : 'Session default directory (not execution confirmation)'}
            : {view.cwd}
          </p>
        ) : null}
        {view.status === 'waiting' ? (
          <p className="activity-note">
            {zh ? '已收到调用请求；尚无进程启动确认' : 'Call requested; process start not confirmed'}
          </p>
        ) : null}
        {view.jobId ? (
          <p className="activity-facts">
            Job: {redactText(view.jobId)} ·{' '}
            {zh ? '已登记，不代表完成或持续存活' : 'registered, not proof of completion or continued liveness'}
          </p>
        ) : null}
        {view.ticketId ? (
          <p className="activity-facts">
            Ticket: {redactText(view.ticketId)}{' '}
            {view.ticket?.childSessionId ? `· Worker: ${redactText(view.ticket.childSessionId)}` : ''}
          </p>
        ) : null}
        {view.latestReport ? (
          <p className="activity-note">
            {zh ? '最新报告' : 'Latest report'} (v{view.ticket?.revision}): {redactText(view.latestReport)}
          </p>
        ) : null}
        {view.todos.length ? (
          <ul className="activity-todos">
            {view.todos.map((todo, index) => (
              <li key={index}>
                <span>{todo.status}</span> {todo.content}
              </li>
            ))}
          </ul>
        ) : null}
        {segment.requestedAt != null ? (
          <p className="activity-facts">
            {zh ? '调用记录时间' : 'Call recorded'}: {new Date(segment.requestedAt).toLocaleString(zh ? 'zh-CN' : 'en')}
            {segment.settledAt != null
              ? ` · ${zh ? '调用等待耗时' : 'Call wait'}: ${Math.max(0, segment.settledAt - segment.requestedAt)}ms`
              : ''}
          </p>
        ) : null}
        {view.exitCode != null ? <p className="activity-facts">Exit: {view.exitCode}</p> : null}
        {change ? <DiffCard change={change} /> : null}
        <ActivityDisclosure
          className="official-row activity-arguments"
          open={argsOpen}
          onToggle={onArgsToggle}
          panelId={`${id}-args`}
          title={
            <>
              <span className="official-leading">
                <ToolIcon />
                <Chevron />
              </span>
              <span className="official-label">{zh ? '完整参数（已脱敏）' : 'Full arguments (redacted)'}</span>
            </>
          }
        >
          <CopyButton text={view.args} />
          <pre>{view.args || '{}'}</pre>
        </ActivityDisclosure>
        {segment.resultReceived || segment.result ? (
          <div className="activity-output">
            <strong>{zh ? '工具返回（已脱敏）' : 'Tool result (redacted)'}</strong>
            <CopyButton text={view.output} />
            <pre>{view.output || (zh ? '（空结果）' : '(empty result)')}</pre>
          </div>
        ) : null}
      </div>
    </ActivityDisclosure>
  )
}

/** All activity folds share the project's height animation and reduced-motion behavior. */
export function ActivityDisclosure({
  className,
  status,
  segmentId,
  open,
  onToggle,
  panelId,
  title,
  children,
}: {
  className: string
  status?: string
  segmentId?: string
  open: boolean
  onToggle: () => void
  panelId: string
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`${className}${open ? ' open' : ''}`} data-state={status} data-segment={segmentId}>
      <button
        type="button"
        className="official-title"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={event => {
          event.stopPropagation()
          onToggle()
        }}
      >
        {title}
      </button>
      <div id={panelId}>
        <Collapse open={open}>{children}</Collapse>
      </div>
    </div>
  )
}

function DiffCard({ change }: { change: FileChange }) {
  const text = change.lines
    .map(line => `${line.kind === 'del' ? '- ' : line.kind === 'add' ? '+ ' : '  '}${line.text}`)
    .join('\n')
  return (
    <div className="diff-card" data-diff="">
      <div className="diff-head">
        <span className="diff-heading">
          <span className="diff-lang">{change.language || 'Code block'}</span>
          <span className="diff-file">{change.name}</span>
        </span>
        <CopyButton text={text} />
      </div>
      <div className="diff-body">
        {change.lines.map((line, index) => (
          <div key={index} className={lineClass(line.kind)}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function lineClass(kind: 'add' | 'del' | 'context'): string {
  if (kind === 'add') return 'diff-line added'
  if (kind === 'del') return 'diff-line removed'
  return 'diff-line same'
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="diff-copy"
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={event => {
        event.stopPropagation()
        void navigator.clipboard.writeText(redactText(text)).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1000)
        })
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 6.5L8 10.5L12 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ThinkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.8c2.8 0 5 2 5 4.6 0 1.6-.8 3-2 3.8-.4.3-.6.7-.6 1.1V12H5.6v-.7c0-.4-.2-.8-.6-1.1-1.2-.8-2-2.2-2-3.8 0-2.6 2.2-4.6 5-4.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6.2 13.6h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function ToolIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.2 4.2h9.6M3.2 8h9.6M3.2 11.8h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.2" y="5.2" width="7.2" height="7.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.2 5.2V3.8A1.3 1.3 0 0 0 8.9 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.1A1.3 1.3 0 0 0 3.8 10.2H5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.2L6.4 11.1L12.5 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
