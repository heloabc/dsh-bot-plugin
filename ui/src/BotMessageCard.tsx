import { mailLabel, type BotMail } from './bot-message'
import { useI18n } from './locale'
import { MarkdownView } from './MarkdownView'

export function BotMessageCard({
  mail,
  label,
  onOpenFile,
}: {
  mail: BotMail
  label: string
  onOpenFile: (path: string, line?: number) => void
}) {
  const { t } = useI18n()
  const who = mailLabel(mail.from, label)
  const hop = /^\d+$/.test(mail.hop) ? mail.hop : ''
  const meta = [
    mail.id ? `id ${mail.id}` : '',
    `from ${mail.from}`,
    mail.correlation ? `correlation ${mail.correlation}` : '',
    mail.causation ? `causation ${mail.causation}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <article className="mail-card">
      <header className="mail-head">
        <span className="bot-badge">BOT</span>
        <span className="mail-who">
          <strong>{who}</strong>
          <span>{t('inbox.received')}</span>
        </span>
        {hop ? <span className="mail-hop">{t('inbox.hop', { hop })}</span> : null}
      </header>
      {mail.body ? (
        <div className="mail-body">
          <MarkdownView text={mail.body} onOpenFile={onOpenFile} />
        </div>
      ) : null}
      <p className="mail-note">{t('inbox.lead')}</p>
      {meta ? (
        <details className="mail-details">
          <summary>{t('inbox.source')}</summary>
          <pre>{meta}</pre>
        </details>
      ) : null}
    </article>
  )
}
