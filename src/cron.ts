const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * Five-field cron in an IANA zone. This is the scheduler used for persisted
 * next_due values. It is not an in-memory timer.
 * @param {string} expr
 */
export function parseCron(expr: string) {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5)
    throw Object.assign(new Error('cron needs 5 fields: minute hour day month weekday'), { code: 'VALIDATION' })
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    day: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    weekday: parseField(fields[4], 0, 6),
  }
}

/**
 * @param {string} expr
 * @param {number} afterMs exclusive lower bound
 * @param {string} timeZone
 */
export function nextCron(expr: string, afterMs: number, timeZone: string) {
  const spec = parseCron(expr)
  const start = Math.floor(afterMs / 60000) * 60000 + 60000
  const limit = start + 370 * 24 * 60 * 60000
  for (let cursor = start; cursor < limit; cursor += 60000) {
    const parts = zonedParts(cursor, timeZone)
    if (!spec.minute.has(parts.minute) || !spec.hour.has(parts.hour) || !spec.month.has(parts.month)) continue
    const dayMatch = spec.day.has(parts.day)
    const weekMatch = spec.weekday.has(parts.weekday)
    const dayStar = spec.day.size === 31
    const weekStar = spec.weekday.size === 7
    const dayOk = dayStar && weekStar ? true : dayStar ? weekMatch : weekStar ? dayMatch : dayMatch || weekMatch
    if (dayOk) return new Date(cursor).toISOString()
  }
  throw Object.assign(new Error('no next fire within one year'), { code: 'VALIDATION' })
}

/**
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function parseField(field: string, min: number, max: number) {
  /** @type {Set<number>} */
  const values: Set<number> = new Set()
  for (const part of field.split(',')) {
    const [span, stepText] = part.split('/')
    const step = stepText == null ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0)
      throw Object.assign(new Error(`invalid cron step: ${field}`), { code: 'VALIDATION' })
    let from = min
    let to = max
    if (span !== '*') {
      const [left, right] = span.split('-')
      from = Number(left)
      to = right == null ? from : Number(right)
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
        throw Object.assign(new Error(`cron field out of range: ${field}`), { code: 'VALIDATION' })
      }
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

/**
 * @param {number} epochMs
 * @param {string} timeZone
 */
export function zonedParts(epochMs: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(epochMs))) bag[part.type] = part.value
  const weekday = WEEKDAYS[bag.weekday]
  if (weekday == null) throw Object.assign(new Error(`cannot read time zone ${timeZone}`), { code: 'VALIDATION' })
  return {
    minute: Number(bag.minute),
    hour: Number(bag.hour),
    day: Number(bag.day),
    month: Number(bag.month),
    weekday,
  }
}
