import { Children, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-block">
      <div className="code-banner">
        <span className="code-lang">{language || 'Code block'}</span>
        <button
          type="button"
          className="code-copy"
          aria-label={copied ? 'Copied' : 'Copy'}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1000)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function Pre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0]
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const element = child as ReactElement<{ className?: string; children?: ReactNode }>
    const text = String(element.props.children ?? '').replace(/\n$/, '')
    const match = /language-([\w-]+)/.exec(element.props.className ?? '')
    return <CodeBlock text={text} language={match?.[1]} />
  }
  return <pre>{children}</pre>
}

function fileTarget(href: string | undefined): { path: string; line?: number } | null {
  if (
    !href ||
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith('#') ||
    href.startsWith('//') ||
    href.startsWith('?')
  )
    return null
  const hash = href.indexOf('#')
  const destination = hash < 0 ? href : href.slice(0, hash)
  if (destination.includes('?')) return null
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch {
    return null
  }
  const suffix = /:(\d+)$/.exec(path)
  if (suffix) path = path.slice(0, -suffix[0].length)
  if (!path || /[\u0000-\u001f\\]/.test(path) || path.split('/').includes('..')) return null
  const line = suffix ? Number(suffix[1]) : undefined
  return line != null && Number.isSafeInteger(line) && line > 0 ? { path, line } : { path }
}

function markdownComponents(streaming: boolean, onOpenFile?: (path: string, line?: number) => void): Components {
  return {
    pre: Pre,
    img({ src, alt, title }) {
      const local = typeof src === 'string' && src !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(src)
      return (
        <img
          src={local ? `/dsh-bot/${src.replace(/^\.\//, '')}` : src || undefined}
          alt={alt}
          title={title}
          loading="lazy"
        />
      )
    },
    code({ className, children }) {
      return <code className={className}>{children}</code>
    },
    table({ children }) {
      return (
        <div className="table-scroll">
          <table>{children}</table>
        </div>
      )
    },
    a({ href, children }) {
      const file = streaming ? null : fileTarget(href)
      if (file && onOpenFile) {
        return (
          <button
            type="button"
            className="file-mention"
            title={file.path}
            onClick={() => onOpenFile(file.path, file.line)}
          >
            {children}
          </button>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
  }
}

function streamingSource(text: string, streaming: boolean): string {
  if (!streaming) return text
  const fences = text.match(/```/g)
  if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``
  return text
}

export function MarkdownView({
  text,
  streaming = false,
  onOpenFile,
}: {
  text: string
  streaming?: boolean
  onOpenFile?: (path: string, line?: number) => void
}) {
  const components = useMemo(() => markdownComponents(streaming, onOpenFile), [streaming, onOpenFile])
  return (
    <div className={streaming ? 'markdown streaming' : 'markdown'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {streamingSource(text, streaming)}
      </ReactMarkdown>
    </div>
  )
}
