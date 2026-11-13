import { useMemo, useState } from 'react'
import { redactText } from './activity.ts'
import { api } from './api.ts'
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

type Draft = { selected: string[]; custom: string; skipped: boolean }

function emptyDraft(item: UserQuestionItem): Draft {
  return { selected: [...item.selected], custom: item.custom, skipped: item.skipped }
}

function OptionList({
  item,
  draft,
  interactive,
  disabled,
  onToggle,
}: {
  item: UserQuestionItem
  draft: Draft
  interactive: boolean
  disabled: boolean
  onToggle: (label: string) => void
}) {
  if (!item.options.length) return null
  const chosen = new Set(draft.selected)
  return (
    <ul className="user-question-options">
      {item.options.map(option => {
        const selected = chosen.has(option.label)
        const className = selected ? 'user-question-option selected' : 'user-question-option'
        const body = (
          <>
            <span className="user-question-option-label">{redactText(option.label)}</span>
            {option.description ? (
              <span className="user-question-option-desc">{redactText(option.description)}</span>
            ) : null}
          </>
        )
        return (
          <li key={option.label}>
            {interactive ? (
              <button
                type="button"
                className={className}
                data-selected={selected ? 'true' : 'false'}
                aria-pressed={item.multiSelect ? selected : undefined}
                disabled={disabled}
                onClick={() => onToggle(option.label)}
              >
                {body}
              </button>
            ) : (
              <div className={className} data-selected={selected ? 'true' : 'false'}>
                {body}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function UserQuestionCard({ segment, sessionId }: { segment: ToolSegment; sessionId?: string }) {
  const { t } = useI18n()
  const view = userQuestionView(segment)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const items = view?.questions ?? []
  const draftOf = useMemo(() => {
    const next: Record<string, Draft> = {}
    for (const item of items) next[item.id] = drafts[item.id] ?? emptyDraft(item)
    return next
  }, [drafts, items])
  if (!view) return null
  const interactive = Boolean(sessionId) && view.state === 'open'
  const needsBatch = items.length > 1 || items.some(item => item.multiSelect || item.options.length === 0)

  function update(id: string, patch: Partial<Draft>) {
    setDrafts(current => {
      const item = items.find(entry => entry.id === id)
      const base = current[id] ?? (item ? emptyDraft(item) : { selected: [], custom: '', skipped: false })
      return { ...current, [id]: { ...base, ...patch } }
    })
  }

  async function submit(answers: Array<{ id: string; selected: string[]; custom?: string }>) {
    if (!sessionId || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await api('/questions/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, callId: view?.callId, answers }),
      })
      if (response.status === 200 && response.body.ok !== false) return
      if (response.status === 409) return
      const message = typeof response.body.message === 'string' ? response.body.message : t('question.submitFailed')
      setError(message)
    } catch {
      setError(t('question.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  function completeItem(
    item: UserQuestionItem,
    draft: Draft,
  ): { id: string; selected: string[]; custom?: string } | null {
    if (draft.skipped) return { id: item.id, selected: [] }
    if (draft.custom.trim() && (item.multiSelect || draft.selected.length === 0 || item.options.length === 0)) {
      return item.multiSelect
        ? { id: item.id, selected: draft.selected, custom: draft.custom }
        : { id: item.id, selected: [], custom: draft.custom }
    }
    if (draft.selected.length) return { id: item.id, selected: [...draft.selected] }
    return null
  }

  function submitDrafts() {
    const answers = items.map(item => completeItem(item, draftOf[item.id] ?? emptyDraft(item)))
    if (answers.some(item => item == null)) {
      setError(t('question.incomplete'))
      return
    }
    void submit(answers as Array<{ id: string; selected: string[]; custom?: string }>)
  }

  function toggle(item: UserQuestionItem, label: string) {
    if (!interactive || busy) return
    if (!item.multiSelect && items.length === 1 && !draftOf[item.id]?.custom) {
      void submit([{ id: item.id, selected: [label] }])
      return
    }
    const current = draftOf[item.id] ?? emptyDraft(item)
    const selected = item.multiSelect
      ? current.selected.includes(label)
        ? current.selected.filter(value => value !== label)
        : [...current.selected, label]
      : [label]
    update(item.id, { selected, skipped: false, custom: item.multiSelect ? current.custom : '' })
  }

  return (
    <section
      className="user-question-card"
      data-segment={segment.id}
      data-state={view.state}
      data-call={view.callId}
      data-session={sessionId || undefined}
    >
      {view.questions.map(item => {
        const draft = draftOf[item.id] ?? emptyDraft(item)
        return (
          <article key={item.id} className="user-question" data-question={item.id}>
            {item.header ? <h3 className="user-question-header">{redactText(item.header)}</h3> : null}
            <p className="user-question-text">{redactText(item.question)}</p>
            {item.multiSelect && view.state === 'open' ? (
              <p className="user-question-hint">{t('question.multiSelect')}</p>
            ) : null}
            <OptionList
              item={item}
              draft={
                view.state === 'open' ? draft : { selected: item.selected, custom: item.custom, skipped: item.skipped }
              }
              interactive={interactive}
              disabled={busy}
              onToggle={label => toggle(item, label)}
            />
            {interactive ? (
              <div className="user-question-actions">
                <label className="user-question-custom">
                  <span>{t('question.customLabel')}</span>
                  <textarea
                    value={draft.custom}
                    disabled={busy}
                    rows={2}
                    placeholder={t('question.customPlaceholder')}
                    onChange={event => update(item.id, { custom: event.target.value, skipped: false })}
                  />
                </label>
                <button
                  type="button"
                  className="user-question-skip"
                  disabled={busy}
                  onClick={() => {
                    if (items.length === 1) {
                      void submit([{ id: item.id, selected: [] }])
                      return
                    }
                    update(item.id, { skipped: true, selected: [], custom: '' })
                  }}
                >
                  {t('question.skip')}
                </button>
              </div>
            ) : null}
            {!interactive && item.custom ? (
              <p className="user-question-hint">{t('question.custom', { text: redactText(item.custom) })}</p>
            ) : null}
            {(item.skipped || draft.skipped) && (view.state !== 'open' || interactive) ? (
              <p className="user-question-hint">{t('question.skipped')}</p>
            ) : null}
          </article>
        )
      })}
      {interactive && (needsBatch || items.some(item => (draftOf[item.id]?.custom ?? '').trim() !== '')) ? (
        <button type="button" className="user-question-submit" disabled={busy} onClick={submitDrafts}>
          {busy ? t('question.submitting') : t('question.submit')}
        </button>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
      {view.state !== 'open' ? (
        <p className={view.state === 'answered' ? 'user-question-status' : 'user-question-status exception'}>
          {t(STATE_LABEL[view.state])}
        </p>
      ) : null}
    </section>
  )
}
