import { useLayoutEffect, useState, type ReactNode, type TransitionEvent } from 'react'

/**
 * Height fold. The grid row animates between 0fr and 1fr.
 * Content mounts before the expand frame and unmounts after the collapse ends.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setExpanded(true))
      return () => cancelAnimationFrame(frame)
    }
    setExpanded(false)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setMounted(false)
  }, [open])

  function onTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return
    if (!open) setMounted(false)
  }

  const classes = ['coll-container', expanded ? 'expand' : '', className].filter(Boolean).join(' ')
  return (
    <div className={classes} onTransitionEnd={onTransitionEnd}>
      <div>{mounted ? children : null}</div>
    </div>
  )
}
