import { useI18n } from './locale'
import type { ToolSegment } from './types'
import { userQuestionView, type UserQuestionItem, type UserQuestionState } from './user-question'

const STATE_LABEL: Record<
  Exclude<UserQuestionState, 'open'>,
  'question.aborted' | 'question.failed' | 'question.answered'
> = {
  aborted: 'question.aborted',
  failed: 'question.failed',
  answered: 'question.answered',
}

function OptionList({ item }: { item: UserQuestionItem }) {
  if (!item.options.length) return null
  const chosen = new Set(item.selected)
  return (
    <ul className="user-question-options">
      {item.options.map(option => {
        const selected = chosen.has(option.label)
        return (
          <li
            key={option.label}
            className={selected ? 'user-question-option selected' : 'user-question-option'}
            data-selected={selected ? 'true' : 'false'}
          >
            <span className="user-question-option-label">{option.label}</span>
            {option.description ? <span className="user-question-option-desc">{option.description}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function UserQuestionCard({ segment }: { segment: ToolSegment }) {
  const { t } = useI18n()
  const view = userQuestionView(segment)
  if (!view) return null
  return (
    <section className="user-question-card" data-segment={segment.id} data-state={view.state} data-call={view.callId}>
      {view.questions.map(item => (
        <article key={item.id} className="user-question" data-question={item.id}>
          {item.header ? <h3 className="user-question-header">{item.header}</h3> : null}
          <p className="user-question-text">{item.question}</p>
          {item.multiSelect && view.state === 'open' ? (
            <p className="user-question-hint">{t('question.multiSelect')}</p>
          ) : null}
          <OptionList item={item} />
          {item.custom ? <p className="user-question-hint">{t('question.custom', { text: item.custom })}</p> : null}
          {item.skipped ? <p className="user-question-hint">{t('question.skipped')}</p> : null}
        </article>
      ))}
      {view.state !== 'open' ? (
        <p className={view.state === 'answered' ? 'user-question-status' : 'user-question-status exception'}>
          {t(STATE_LABEL[view.state])}
        </p>
      ) : null}
    </section>
  )
}
