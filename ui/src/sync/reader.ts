import {
  CDC_MIN_BYTES,
  LIVENESS_CHECK_MS,
  OPENING_MESSAGES,
  POLL_MS,
  RANGE_MAX_EVENTS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  RESUME_DEBOUNCE_MS,
  RESUME_RESYNC_HIDDEN_MS,
  RESUME_SILENT_MS,
  WS_DEGRADE_AFTER,
} from './constants.ts'
import { Sequencer } from './sequencer.ts'
import { probeEnhancement } from './range.ts'
import { browserResumeSource, documentHidden, type ResumeInfo, type ResumeSource } from './resume.ts'
import type { BoundedTransport, FollowOpenedInfo, LiveTransport, TransportSink } from './transport.ts'
import type { CheckpointStore } from './checkpoint.ts'
import type {
  EventLogReader,
  EventLogReaderOptions,
  LogBatch,
  Subscription,
  SyncResult,
  SyncStatus,
} from './reader-types.ts'
import type { LogEvent, SessionAddress } from './types.ts'

export type {
  EventLogReader,
  EventLogReaderOptions,
  LogBatch,
  Subscription,
  SyncResult,
  SyncStatus,
} from './reader-types.ts'
export type { ResumeInfo, ResumeReason, ResumeSource } from './resume.ts'

export interface EventLogReaderDeps {
  follow: LiveTransport
  page: BoundedTransport
  cdc?: BoundedTransport
  range?: BoundedTransport
  checkpoint: CheckpointStore
  probe?: () => Promise<boolean>
  openingMessages?: number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  raf?: (cb: () => void) => unknown
  cancelRaf?: (id: unknown) => void
  /**
   * Page resume signal (visible again, bfcache restore, back online, focus).
   * Defaults to the browser's visibilitychange/pageshow/online/focus events; a no-op outside a browser.
   */
  onResume?: ResumeSource
  /** Whether the page is hidden right now. Defaults to `document.visibilityState === 'hidden'`. */
  isHidden?: () => boolean
  now?: () => number
  /** Interval for the visible-tab follow liveness check; `false` disables it. */
  livenessMs?: number | false
}

export function createEventLogReader(deps: EventLogReaderDeps): EventLogReader {
  return {
    open(sessionId, options) {
      return openSubscription(deps, sessionId, options ?? {})
    },
  }
}

function openSubscription(deps: EventLogReaderDeps, sessionId: string, options: EventLogReaderOptions): Subscription {
  const control = new AbortController()
  const batchListeners = new Set<(batch: LogBatch) => void>()
  const ephemeralListeners = new Set<(frame: unknown) => void>()
  const statusListeners = new Set<(status: SyncStatus) => void>()
  let status: SyncStatus = { phase: 'restoring', appliedSeq: -1, headSeq: null, lag: null, fraction: null }
  let resolveReady: (result: SyncResult) => void
  const ready = new Promise<SyncResult>(resolve => {
    resolveReady = resolve
  })
  let readySettled = false
  const finishReady = (result: SyncResult) => {
    if (readySettled) return
    readySettled = true
    resolveReady(result)
  }
  let queued: LogEvent[] = []
  let fromCache = false
  // Pending flush: rAF while visible; a timer while hidden, because rAF does not run in background tabs.
  let raf: { kind: 'raf' | 'timer'; id: unknown } | null = null
  const rafImpl =
    deps.raf ??
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0))
  const cancelRafImpl =
    deps.cancelRaf ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)
  const cancelPending = () => {
    if (raf == null) return
    if (raf.kind === 'timer') clearTimeout(raf.id as ReturnType<typeof setTimeout>)
    else cancelRafImpl(raf.id as number)
    raf = null
  }
  const wait = deps.wait ?? defaultWait
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now
  const isHidden = deps.isHidden ?? documentHidden
  const flush = () => {
    raf = null
    if (queued.length === 0) return
    const events = queued
    queued = []
    const batch: LogBatch = { events, fromCache }
    fromCache = false
    for (const listener of batchListeners) listener(batch)
  }
  const flushNow = () => {
    cancelPending()
    flush()
  }
  const deliver = (events: readonly LogEvent[], cached = false) => {
    if (events.length === 0) return
    if (cached) fromCache = true
    queued.push(...events)
    if (raf != null) return
    // Publish the handle before scheduling so a synchronous scheduler that flushes inline cannot leave it stuck.
    const handle: { kind: 'raf' | 'timer'; id: unknown } = { kind: isHidden() ? 'timer' : 'raf', id: null }
    raf = handle
    handle.id = handle.kind === 'timer' ? setTimeout(flush, 0) : rafImpl(flush)
  }
  const setStatus = (patch: Partial<SyncStatus>) => {
    status = {
      ...status,
      ...patch,
      lag:
        (patch.headSeq ?? status.headSeq) == null || (patch.appliedSeq ?? status.appliedSeq) == null
          ? (patch.lag ?? status.lag)
          : (patch.headSeq ?? status.headSeq)! - (patch.appliedSeq ?? status.appliedSeq),
    }
    for (const listener of statusListeners) listener(status)
  }

  // Reconnect state lives here so a page resume can reset it.
  let followFailures = 0
  let degraded = false
  let attempt = 0
  let running = true
  /** Abort controller of the backoff/poll sleep in progress, if any. */
  let wakeCtl: AbortController | null = null
  /** A resume arrived between steps; skip the next sleep. */
  let wakePending = false
  /** Current follow generation and its local liveness probe. */
  let generation: AbortController | null = null
  let genAlive: (() => boolean) | null = null
  /** Set when a resume aborted the generation on purpose; not counted as a follow failure. */
  let resyncRequested = false
  let lastFrameAt = now()
  let lastForcedAt = Number.NEGATIVE_INFINITY

  const sleep = async (ms: number) => {
    if (control.signal.aborted) return
    if (wakePending) {
      wakePending = false
      return
    }
    const ctl = new AbortController()
    wakeCtl = ctl
    const stop = () => ctl.abort()
    control.signal.addEventListener('abort', stop, { once: true })
    try {
      await wait(ms, ctl.signal)
    } catch {
      /* woken or closed */
    } finally {
      control.signal.removeEventListener('abort', stop)
      if (wakeCtl === ctl) wakeCtl = null
    }
  }
  const takeResync = () => {
    const requested = resyncRequested
    resyncRequested = false
    return requested
  }

  /**
   * Page came back (visible, bfcache, online, focus) or the liveness check failed.
   * Always: deliver anything queued while hidden, reset backoff, and wake a pending sleep.
   * Forced resync: abort the live follow generation so the loop reopens follow, gets a new
   * cursor F, fills (appliedSeq, F-1] and goes live again. The Sequencer drops seq <= appliedSeq.
   */
  const resume = (info: ResumeInfo) => {
    if (!running || control.signal.aborted) return
    flushNow()
    const t = now()
    const alive = genAlive ? genAlive() : true
    const silent = t - lastFrameAt >= RESUME_SILENT_MS
    const force =
      !alive ||
      info.reason === 'online' ||
      info.persisted === true ||
      info.hiddenMs >= RESUME_RESYNC_HIDDEN_MS ||
      (info.reason !== 'focus' && silent)
    attempt = 0
    followFailures = 0
    degraded = false
    if (wakeCtl) {
      wakeCtl.abort()
      return
    }
    if (!generation) {
      wakePending = true
      return
    }
    if (!force) return
    if (t - lastForcedAt < RESUME_DEBOUNCE_MS) return
    lastForcedAt = t
    if (!generation.signal.aborted) {
      resyncRequested = true
      generation.abort()
    }
  }

  void run()

  async function run() {
    try {
      await runLoop()
    } finally {
      running = false
      stopLiveness()
    }
  }

  async function runLoop() {
    const cursor = await deps.checkpoint.getCursor(sessionId)
    let applied = cursor?.appliedSeq ?? -1
    const cachedEvents = await deps.checkpoint.readEvents(sessionId, -1)
    const prefix = continuousPrefix(cachedEvents, -1).filter(event => event.seq <= applied || applied < 0)
    if (applied < 0 && prefix.length) applied = prefix[prefix.length - 1]!.seq
    const sequencer = new Sequencer(applied)
    if (cursor?.headSeq != null) sequencer.setHead(cursor.headSeq)
    if (prefix.length) deliver(prefix, true)
    setStatus({ phase: 'connecting', appliedSeq: sequencer.appliedSeq, headSeq: sequencer.headSeq })

    let enhance = options.enhancement === 'off' ? false : await detectEnhance()

    const sinkBase = (): TransportSinkForAll => {
      return {
        events(batch) {
          const result = sequencer.push(batch)
          // Live follow events move past the cursor taken at open; keep head >= applied so lag stays >= 0.
          if (sequencer.headSeq != null && sequencer.appliedSeq > sequencer.headSeq)
            sequencer.setHead(sequencer.appliedSeq)
          if (result.delivered.length) {
            deliver(result.delivered)
            void deps.checkpoint.putEvents(sessionId, result.delivered)
            void deps.checkpoint.setCursor(sessionId, sequencer.appliedSeq, sequencer.headSeq)
          }
          setStatus({ appliedSeq: sequencer.appliedSeq, headSeq: sequencer.headSeq, fraction: status.fraction })
          if (result.overflow) {
            /* pending dropped; a later catch-up rereads the durable log */
          }
        },
        head(seq) {
          sequencer.setHead(seq)
          setStatus({ headSeq: sequencer.headSeq, appliedSeq: sequencer.appliedSeq })
        },
        progress(p) {
          const fraction = p.total && p.total > 0 ? Math.min(1, p.loaded / p.total) : null
          setStatus({ fraction, appliedSeq: sequencer.appliedSeq, headSeq: sequencer.headSeq })
        },
        ephemeral(frame) {
          for (const listener of ephemeralListeners) listener(frame)
        },
        opened() {},
      }
    }

    const fillGap = async (afterSeq: number, throughSeq: number, signal: AbortSignal) => {
      if (throughSeq <= afterSeq) return { ok: true as const, throughSeq }
      setStatus({ phase: 'syncing', fraction: status.fraction })
      const size = throughSeq - afterSeq
      const sink = sinkBase()
      const useCdc = enhance && deps.cdc != null && (size > RANGE_MAX_EVENTS || size * 128 > CDC_MIN_BYTES)
      const useRange = enhance && deps.range != null && !useCdc
      if (useRange && deps.range) {
        const outcome = await deps.range.fetch({ sessionId, afterSeq, throughSeq }, sink, signal)
        if (outcome.ok || signal.aborted) return outcome
        enhance = false
      } else if (useCdc && deps.cdc) {
        const outcome = await deps.cdc.fetch({ sessionId, afterSeq, throughSeq }, sink, signal)
        if (outcome.ok || signal.aborted) return outcome
        enhance = false
      }
      return deps.page.fetch({ sessionId, afterSeq: sequencer.appliedSeq, throughSeq }, sink, signal)
    }

    while (!control.signal.aborted) {
      if (degraded) {
        setStatus({ phase: 'stalled', appliedSeq: sequencer.appliedSeq, headSeq: sequencer.headSeq, fraction: null })
        const poll = new AbortController()
        const stopPoll = () => poll.abort()
        control.signal.addEventListener('abort', stopPoll)
        const headGuess = sequencer.headSeq ?? sequencer.appliedSeq
        const page = await deps.page.fetch(
          { sessionId, afterSeq: sequencer.appliedSeq, throughSeq: Math.max(headGuess, sequencer.appliedSeq) },
          sinkBase(),
          poll.signal,
        )
        control.signal.removeEventListener('abort', stopPoll)
        if (page.ok && sequencer.headSeq != null && sequencer.appliedSeq >= sequencer.headSeq) {
          setStatus({
            phase: 'live',
            appliedSeq: sequencer.appliedSeq,
            headSeq: sequencer.headSeq,
            fraction: null,
            error: undefined,
          })
          finishReady({ ok: true, caughtUpTo: sequencer.appliedSeq })
        }
        attempt += 1
        const delay = reconnectDelay(attempt, random)
        await sleep(Math.min(delay, POLL_MS))
        degraded = followFailures >= WS_DEGRADE_AFTER
        // keep trying follow as well
      }
      if (control.signal.aborted) break

      setStatus({
        phase: status.phase === 'restoring' ? 'connecting' : status.phase === 'live' ? 'syncing' : 'connecting',
      })
      const gen = new AbortController()
      generation = gen
      genAlive = null
      const stopGen = () => gen.abort()
      control.signal.addEventListener('abort', stopGen)
      const endGen = () => {
        control.signal.removeEventListener('abort', stopGen)
        gen.abort()
        if (generation === gen) {
          generation = null
          genAlive = null
        }
      }
      let opened: FollowOpenedInfo | null = null
      const base = sinkBase()
      const touch = () => {
        if (generation === gen) lastFrameAt = now()
      }
      const sink = {
        events(batch: readonly LogEvent[], meta?: { throughSeq?: number }) {
          touch()
          base.events(batch, meta)
        },
        head(seq: number) {
          touch()
          base.head(seq)
        },
        progress: base.progress,
        ephemeral(frame: unknown) {
          touch()
          base.ephemeral(frame)
        },
        opened(info: FollowOpenedInfo) {
          touch()
          opened = info
          if (generation === gen) genAlive = info.alive ?? null
          sequencer.setHead(info.cursor)
          setStatus({ headSeq: info.cursor, appliedSeq: sequencer.appliedSeq, phase: 'syncing' })
        },
      }
      const followDone = deps.follow.open({ sessionId }, sink, gen.signal)
      const first = await Promise.race([
        followDone.then(outcome => ({ kind: 'done' as const, outcome })),
        waitFor(() => opened != null, gen.signal, wait).then(() => ({ kind: 'opened' as const })),
      ])
      const info = opened as FollowOpenedInfo | null
      if (first.kind === 'done' || info == null || gen.signal.aborted) {
        endGen()
        if (control.signal.aborted) break
        if (takeResync()) continue
        followFailures += 1
        if (followFailures >= WS_DEGRADE_AFTER) degraded = true
        attempt += 1
        await sleep(reconnectDelay(attempt, random))
        continue
      }
      followFailures = 0
      attempt = 0
      const gapThrough = info.firstSeq - 1
      const gap = await fillGap(sequencer.appliedSeq, gapThrough, gen.signal)
      if (gen.signal.aborted) {
        endGen()
        if (control.signal.aborted) break
        takeResync()
        continue
      }
      if (!gap.ok && !gap.retryable) {
        setStatus({
          phase: 'error',
          error: { code: gap.code, message: gap.message ?? gap.code, retrying: false },
          appliedSeq: sequencer.appliedSeq,
          headSeq: sequencer.headSeq,
        })
        finishReady({ ok: false, code: gap.code, message: gap.message ?? gap.code })
        endGen()
        break
      }
      if (!gap.ok) {
        // A retryable gap failure must not go live with a hole; reopen follow after a backoff.
        endGen()
        setStatus({
          phase: 'stalled',
          error: { code: gap.code, message: gap.message ?? gap.code, retrying: true },
          appliedSeq: sequencer.appliedSeq,
          headSeq: sequencer.headSeq,
        })
        attempt += 1
        await sleep(reconnectDelay(attempt, random))
        continue
      }
      setStatus({
        phase: 'live',
        appliedSeq: sequencer.appliedSeq,
        headSeq: sequencer.headSeq,
        fraction: null,
        error: undefined,
      })
      if (sequencer.appliedSeq >= gapThrough) finishReady({ ok: true, caughtUpTo: sequencer.appliedSeq })
      const outcome = await followDone
      endGen()
      if (control.signal.aborted) break
      if (takeResync()) continue
      if (!outcome.ok) {
        followFailures += 1
        if (followFailures >= WS_DEGRADE_AFTER) degraded = true
        setStatus({
          phase: 'stalled',
          error: { code: outcome.code, message: outcome.message ?? outcome.code, retrying: true },
        })
        attempt += 1
        await sleep(reconnectDelay(attempt, random))
      }
    }
    if (status.phase !== 'error') setStatus({ phase: 'closed' })
    cancelPending()
  }

  async function detectEnhance() {
    if (options.enhancement === 'off') return false
    if (!deps.cdc && !deps.range) return false
    if (deps.probe) return deps.probe()
    return probeEnhancement()
  }

  const unsubscribeResume = (deps.onResume ?? browserResumeSource)(resume)
  const livenessMs = deps.livenessMs === undefined ? LIVENESS_CHECK_MS : deps.livenessMs
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  if (livenessMs !== false && livenessMs > 0) {
    livenessTimer = setInterval(() => {
      if (isHidden() || !generation || !genAlive) return
      if (!genAlive()) resume({ reason: 'liveness', hiddenMs: 0 })
    }, livenessMs)
    const timer = livenessTimer as { unref?: () => void }
    timer.unref?.()
  }
  function stopLiveness() {
    if (livenessTimer != null) clearInterval(livenessTimer)
    livenessTimer = null
  }

  return {
    onBatch(listener) {
      batchListeners.add(listener)
      return () => batchListeners.delete(listener)
    },
    onEphemeral(listener) {
      ephemeralListeners.add(listener)
      return () => ephemeralListeners.delete(listener)
    },
    onStatus(listener) {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    get status() {
      return status
    },
    ready,
    close() {
      unsubscribeResume()
      stopLiveness()
      control.abort()
      cancelPending()
      setStatus({ phase: 'closed' })
    },
  }
}

type TransportSinkForAll = {
  events: TransportSink['events']
  head: TransportSink['head']
  progress: TransportSink['progress']
  ephemeral: TransportSink['ephemeral']
  opened(info: FollowOpenedInfo): void
}

function continuousPrefix(events: readonly LogEvent[], afterSeq: number) {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const out: LogEvent[] = []
  let expect = afterSeq + 1
  for (const event of ordered) {
    if (event.seq < expect) continue
    if (event.seq !== expect) break
    out.push(event)
    expect = event.seq + 1
  }
  return out
}

function reconnectDelay(attempt: number, random: () => number) {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1))
  return cap * (0.5 + random() * 0.5)
}

function defaultWait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitFor(
  isReady: () => boolean,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
) {
  while (!isReady() && !signal.aborted) await wait(5, signal).catch(() => {})
}

export function readerOptionsWithAddress(
  options: EventLogReaderOptions | undefined,
  address: SessionAddress | undefined,
): EventLogReaderOptions {
  return { openingMessages: OPENING_MESSAGES, ...options, address }
}

export type { SessionAddress }
