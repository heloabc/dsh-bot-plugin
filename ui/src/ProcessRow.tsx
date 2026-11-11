import { useState } from 'react'
import { Collapse } from './Collapse'
import {
  fileChange,
  processHeading,
  thinkPreview,
  toolDetail,
  toolTitle,
  type ActivitySegment,
  type FileChange,
} from './follow'
import { useI18n } from './locale'
import { bookkeepingOnly } from './work'
import { type ThinkSegment, type ToolSegment } from './types'

export function ThinkRow({ segment }: { segment: ThinkSegment }) {
  const [open, setOpen] = useState(false)
  const preview = thinkPreview(segment.text)
  return (
    <div
      className={open ? 'official-row open' : 'official-row'}
      data-variant="think"
      data-state={segment.running ? 'running' : 'ok'}
    >
      <button type="button" className="official-title" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="official-leading" aria-hidden="true">
          <ThinkIcon />
          <Chevron />
        </span>
        <span className={segment.running ? 'official-label shimmer' : 'official-label'}>Think</span>
        {preview ? <span className="official-dot" /> : null}
        {preview ? (
          <span className={segment.running ? 'official-summary streaming' : 'official-summary'}>{preview}</span>
        ) : null}
      </button>
      <Collapse open={open}>
        <div className="think-body">{segment.text}</div>
      </Collapse>
    </div>
  )
}

export function ActivityGroup({ segments, quiet = false }: { segments: ActivitySegment[]; quiet?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const running = segments.some(segment => segment.running)
  if (quiet && bookkeepingOnly(segments)) return null
  if (segments.every(segment => segment.kind === 'think')) {
    return segments.map(segment => <ThinkRow key={segment.id} segment={segment} />)
  }
  const label = quiet ? (running ? t('bot.thinking') : t('bot.processed')) : processHeading(segments, running)
  return (
    <div className={open ? 'activity-group open' : 'activity-group'} data-state={running ? 'running' : 'ok'}>
      <button type="button" className="official-title" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="official-leading" aria-hidden="true">
          {running ? <ToolIcon /> : <CheckIcon />}
          <Chevron />
        </span>
        <span className={running ? 'official-label shimmer' : 'official-label'}>{label}</span>
      </button>
      <Collapse open={open}>
        <div className="activity-body">
          {segments.map(segment =>
            segment.kind === 'think' ? (
              <ThinkRow key={segment.id} segment={segment} />
            ) : (
              <ToolCallRow key={segment.id} segment={segment} />
            ),
          )}
        </div>
      </Collapse>
    </div>
  )
}

export function ToolCallRow({ segment }: { segment: ToolSegment }) {
  const [open, setOpen] = useState(false)
  const change = fileChange(segment)
  const summary = change?.name || bashSummary(segment) || toolDetail(segment.name, segment.args)
  const expandable = Boolean(change || segment.result || segment.args)
  return (
    <div
      className={open ? 'official-row open' : 'official-row'}
      data-state={segment.error ? 'error' : segment.running ? 'running' : 'ok'}
    >
      <button
        type="button"
        className="official-title"
        aria-expanded={open}
        disabled={!expandable}
        onClick={() => setOpen(value => !value)}
      >
        <span className="official-leading" aria-hidden="true">
          <ToolIcon />
          <Chevron />
        </span>
        <span className={segment.running ? 'official-label shimmer' : 'official-label'}>{toolTitle(segment)}</span>
        {summary ? <span className="official-dot" /> : null}
        {summary ? <span className="official-summary">{summary}</span> : null}
        {change ? <span className="official-size">{change.kilobytes}KB</span> : null}
        {change ? <DiffCounts added={change.added} removed={change.removed} /> : null}
      </button>
      {expandable ? (
        <Collapse open={open}>
          <ToolBody segment={segment} change={change} />
        </Collapse>
      ) : null}
    </div>
  )
}

function ToolBody({ segment, change }: { segment: ToolSegment; change: FileChange | null }) {
  if (change) return <DiffCard change={change} />
  const command = toolDetail(segment.name, segment.args)
  return (
    <div className="diff-card">
      <div className="diff-head">
        <span className="diff-lang">{command || segment.name}</span>
        <CopyButton text={segment.result || command} />
      </div>
      {segment.result ? <pre className="diff-output">{segment.result}</pre> : null}
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

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-counts">
      <span className="diff-plus">+{added}</span>
      <span className="diff-minus">-{removed}</span>
    </span>
  )
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
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1000)
        })
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

function bashSummary(segment: ToolSegment): string {
  try {
    const parsed = JSON.parse(segment.args) as Record<string, unknown>
    if (typeof parsed.description === 'string' && parsed.description.trim()) return parsed.description.trim()
    if (typeof parsed.command === 'string') return parsed.command.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
  return ''
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
