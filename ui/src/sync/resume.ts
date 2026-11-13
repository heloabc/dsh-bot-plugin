/** Why the page asked the reader to resume. */
export type ResumeReason = 'visible' | 'pageshow' | 'online' | 'focus' | 'liveness' | 'manual'

export interface ResumeInfo {
  reason: ResumeReason
  /** How long the document was hidden before this resume (0 if it was not hidden). */
  hiddenMs: number
  /** True when the page came back from the back/forward cache. */
  persisted?: boolean
}

export type ResumeSource = (cb: (info: ResumeInfo) => void) => () => void

/**
 * Browser resume signal: visibilitychange to visible, pageshow, online, and focus.
 * Returns a no-op outside a browser (unit tests, SSR).
 */
export const browserResumeSource: ResumeSource = cb => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
  const hiddenMs = () => (hiddenAt == null ? 0 : Math.max(0, Date.now() - hiddenAt))
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (hiddenAt == null) hiddenAt = Date.now()
      return
    }
    const ms = hiddenMs()
    hiddenAt = null
    cb({ reason: 'visible', hiddenMs: ms })
  }
  const onPageHide = () => {
    if (hiddenAt == null) hiddenAt = Date.now()
  }
  const onPageShow = (event: PageTransitionEvent) => {
    const ms = hiddenMs()
    hiddenAt = null
    cb({ reason: 'pageshow', hiddenMs: ms, persisted: event.persisted })
  }
  const onOnline = () => cb({ reason: 'online', hiddenMs: hiddenMs() })
  const onFocus = () => {
    if (document.visibilityState === 'hidden') return
    const ms = hiddenMs()
    hiddenAt = null
    cb({ reason: 'focus', hiddenMs: ms })
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', onOnline)
  window.addEventListener('focus', onFocus)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('focus', onFocus)
  }
}

export function documentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}
