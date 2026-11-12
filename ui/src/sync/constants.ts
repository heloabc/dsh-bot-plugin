export const OPENING_MESSAGES = 1
export const PAGE_MAX_MESSAGES = 500
export const PAGE_TURN_WINDOW = { minMessages: 50, minTurns: 2 }
export const RANGE_PAGE_LIMIT = 500
export const RANGE_MAX_EVENTS = 2000
export const CDC_MIN_BYTES = 256 * 1024
export const CDC_CONCURRENCY = 6
export const CDC_CHUNK_RETRIES = 3
export const PENDING_MAX_EVENTS = 5000
export const PENDING_MAX_BYTES = 8 * 1024 * 1024
export const POLL_MS = 2000
export const RECONNECT_MIN_MS = 500
export const RECONNECT_MAX_MS = 10_000
export const WS_DEGRADE_AFTER = 3
export const CHUNK_CAP = 64 * 1024 * 1024
export const ENHANCE_RANGE_PATH = '/api/dsh-bot/log/range'
export const ENHANCE_MANIFEST_PATH = '/api/dsh-bot/log/manifest'
export const ENHANCE_CHUNK_PATH = '/api/dsh-bot/log/chunk'
export const SESSION_EVENTS_PATH = '/api/session/events'
/** Hidden at least this long before a resume forces a follow reopen and gap fill. */
export const RESUME_RESYNC_HIDDEN_MS = 3000
/** No follow frame for this long and a resume forces a reopen even if the tab was not hidden. */
export const RESUME_SILENT_MS = 30_000
/** Forced resyncs closer together than this are coalesced (visibilitychange + focus + pageshow). */
export const RESUME_DEBOUNCE_MS = 1000
/** While visible, how often the reader checks that the follow socket is still OPEN. */
export const LIVENESS_CHECK_MS = 15_000
