import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { useI18n } from './locale'

export function FilePreview({
  sessionId,
  path,
  line,
  onClose,
}: {
  sessionId: string
  path: string
  line?: number
  onClose: () => void
}) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; text: string; eof: boolean }>({
    status: 'loading',
    text: '',
    eof: true,
  })
  const { t } = useI18n()
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  const language = languageFor(name)

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', text: '', eof: true })
    const query = `/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
    void api(query, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        const text = typeof result.body.text === 'string' ? result.body.text : ''
        if (result.status !== 200) {
          setState({ status: 'error', text: '', eof: true })
          return
        }
        setState({ status: 'ready', text, eof: result.body.eof !== false })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', text: '', eof: true })
      })
    return () => controller.abort()
  }, [sessionId, path])

  return createPortal(
    <div className="file-modal" role="presentation">
      <div className="file-modal-mask" onClick={onClose} />
      <div className="file-modal-card" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
        <header className="file-modal-head">
          <div className="file-modal-title">
            <strong>{name}</strong>
            {path !== name ? <span>{path}</span> : null}
          </div>
          <button type="button" className="file-modal-close" aria-label={t('file.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <PreviewBody state={state} language={language} line={line} />
      </div>
    </div>,
    document.body,
  )
}

function PreviewBody({
  state,
  language,
  line,
}: {
  state: { status: 'loading' | 'ready' | 'error'; text: string; eof: boolean }
  language: string
  line?: number
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  if (state.status === 'loading') return <p className="file-modal-status">{t('file.loading')}</p>
  if (state.status === 'error') return <p className="file-modal-status">{t('file.error')}</p>
  const lines = state.text === '' ? [] : state.text.split('\n')
  return (
    <div className="file-preview" data-code-preview="">
      <div className="file-preview-banner">
        <span className="file-preview-lang">{language || 'Code'}</span>
        <button
          type="button"
          className="diff-copy"
          aria-label={copied ? 'Copied' : 'Copy'}
          onClick={() => {
            void navigator.clipboard.writeText(state.text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1000)
            })
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <div className="file-preview-scroll">
        <pre>
          <code style={{ ['--line-width' as string]: `${Math.max(2, String(lines.length).length)}ch` }}>
            {lines.map((text, index) => (
              <span key={index} className={line === index + 1 ? 'source-line current' : 'source-line'}>
                {text}
              </span>
            ))}
          </code>
        </pre>
      </div>
      {state.eof ? null : <p className="file-modal-note">{t('file.truncated')}</p>}
    </div>
  )
}

function languageFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const languages: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    md: 'markdown',
    css: 'css',
    html: 'html',
    json: 'json',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    c: 'c',
  }
  return languages[ext] ?? ''
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.2 4.2L11.8 11.8M11.8 4.2L4.2 11.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
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
