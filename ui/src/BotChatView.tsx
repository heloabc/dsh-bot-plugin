import { mailLabel } from './bot-message'
import { outboundPeer, type BotExchangeItem } from './bot-chat'
import { BotMessageCard } from './BotMessageCard'
import { useI18n } from './locale'

export function InboxLine({
  who,
  preview,
  time,
  mark,
  onOpen,
}: {
  who: string
  preview: string
  time?: string
  mark?: string
  onOpen: () => void
}) {
  const { t } = useI18n()
  const line = preview || t('inbox.received')
  return (
    <div className="inbox-line" data-turn={mark}>
      <button type="button" className="inbox-entry" onClick={onOpen} aria-label={t('inbox.open', { who, line })}>
        <span className="inbox-icon">
          <InboxIcon />
        </span>
        <span className="inbox-copy">
          <strong>{who}</strong>
          <span>{line}</span>
        </span>
      </button>
      {time ? <time>{time}</time> : null}
    </div>
  )
}

export function BotChatView({
  items,
  botLabel,
  onOpenFile,
}: {
  items: readonly BotExchangeItem[]
  botLabel: (sessionId: string) => string
  onOpenFile: (path: string, line?: number) => void
}) {
  const { locale } = useI18n()
  return (
    <div className="bot-chat">
      <Lead />
      {items.length === 0 ? <Empty /> : null}
      {items.map(item =>
        item.kind === 'in' ? (
          <div key={item.id} className="mail-row">
            <BotMessageCard mail={item.mail} label={botLabel(item.mail.from)} onOpenFile={onOpenFile} />
            {clock(item.time, locale) ? <time>{clock(item.time, locale)}</time> : null}
          </div>
        ) : (
          <OutboundLine key={item.id} item={item} items={items} botLabel={botLabel} />
        ),
      )}
    </div>
  )
}

function OutboundLine({
  item,
  items,
  botLabel,
}: {
  item: Extract<BotExchangeItem, { kind: 'out' }>
  items: readonly BotExchangeItem[]
  botLabel: (sessionId: string) => string
}) {
  const { t, locale } = useI18n()
  const peer = outboundPeer(item, items)
  const name = peer ? mailLabel(peer, botLabel(peer)) : t('inbox.other')
  return (
    <div className="bot-out">
      <div className="user-bubble">{item.text}</div>
      <span>{t('inbox.sentTo', { name })}</span>
      {clock(item.time, locale) ? <time>{clock(item.time, locale)}</time> : null}
    </div>
  )
}

function Lead() {
  const { t } = useI18n()
  return <p className="bot-chat-lead">{t('inbox.lead')}</p>
}

function Empty() {
  const { t } = useI18n()
  return <p className="empty-thread">{t('inbox.empty')}</p>
}

function clock(time: number | undefined, locale: string): string {
  if (!time) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' })
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 13.2 6.4 5.5h11.2L20 13.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M4 13.2h4.1l1.1 2h5.6l1.1-2H20V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
