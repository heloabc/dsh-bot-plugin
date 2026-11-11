import { useEffect, useRef, useState, type RefObject } from 'react'
import { useI18n } from './locale'
import type { RailMark } from './turn-marks'

export function TurnRail({
  root,
  marks,
  busyId,
}: {
  root: RefObject<HTMLElement | null>
  marks: readonly RailMark[]
  busyId?: string
}) {
  const railRef = useRef<HTMLElement>(null)
  const [active, setActive] = useState(marks.at(-1)?.id ?? '')
  const [hover, setHover] = useState<string | null>(null)
  const [fade, setFade] = useState({ top: false, bottom: false })
  const markKey = marks.map(mark => mark.id).join('\0')

  useEffect(() => {
    const node = root.current
    if (!node || marks.length < 2) return
    const update = () => {
      const top = node.getBoundingClientRect().top
      const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      let current = marks[0]?.id ?? ''
      if (atEnd) current = marks.at(-1)?.id ?? current
      else {
        for (const mark of marks) {
          const el = node.querySelector(`[data-turn="${CSS.escape(mark.id)}"]`)
          if (!(el instanceof HTMLElement)) continue
          if (el.getBoundingClientRect().top - top <= 36) current = mark.id
        }
      }
      setActive(value => (value === current ? value : current))
    }
    update()
    node.addEventListener('scroll', update, { passive: true })
    return () => node.removeEventListener('scroll', update)
  }, [root, marks, markKey])

  useEffect(() => {
    const rail = railRef.current
    const button = rail?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    if (!rail || !button) return
    const next = button.offsetTop - (rail.clientHeight - button.offsetHeight) / 2
    rail.scrollTop = Math.max(0, next)
    const top = rail.scrollTop > 1
    const bottom = rail.scrollTop < rail.scrollHeight - rail.clientHeight - 1
    setFade(value => (value.top === top && value.bottom === bottom ? value : { top, bottom }))
  }, [active, markKey])

  const { t } = useI18n()
  if (marks.length < 2) return null
  const motion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <nav
      ref={railRef}
      className={['turn-rail', fade.top ? 'fade-top' : '', fade.bottom ? 'fade-bottom' : ''].filter(Boolean).join(' ')}
      aria-label={t('turn.rail')}
      onMouseLeave={() => setHover(null)}
    >
      {marks.map((mark, index) => {
        const current = mark.id === active
        return (
          <button
            key={mark.id}
            type="button"
            className={[
              'turn-mark',
              current ? 'active' : '',
              mark.id === hover ? 'preview' : '',
              mark.id === busyId ? 'busy' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-current={current ? 'true' : undefined}
            aria-label={t('turn.jump', { index: String(index + 1) })}
            onMouseEnter={() => setHover(mark.id)}
            onFocus={() => setHover(mark.id)}
            onBlur={() => setHover(value => (value === mark.id ? null : value))}
            onClick={() => {
              const el = root.current?.querySelector(`[data-turn="${CSS.escape(mark.id)}"]`)
              el?.scrollIntoView({ block: 'start', behavior: motion ? 'auto' : 'smooth' })
            }}
          />
        )
      })}
    </nav>
  )
}
