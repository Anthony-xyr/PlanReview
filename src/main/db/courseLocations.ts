import type { DatabaseSync } from 'node:sqlite'
import { atClock, meetingDate } from './courseRepo'

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/

interface UnlocatedBlock {
  id: string
  course_id: string
  start_at: string
  end_at: string
  term_start: string
  meetings: string
  default_location: string
}

function intervalKey(start: number, end: number): string {
  return `${start}:${end}`
}

function occurrenceLocations(termStart: string, storedMeetings: string): Map<string, string> {
  const locations = new Map<string, string>()
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(termStart)
  if (!parts) return locations
  const [, y, m, d] = parts.map(Number)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return locations

  let meetings: unknown
  try { meetings = JSON.parse(storedMeetings) } catch { return locations }
  if (!Array.isArray(meetings)) return locations

  for (const m of meetings) {
    if (!m || !Number.isInteger(m.weekday) || m.weekday < 1 || m.weekday > 7 || !Array.isArray(m.weeks) ||
        typeof m.start !== 'string' || typeof m.end !== 'string' || !clock.test(m.start) || !clock.test(m.end) || m.start >= m.end) continue
    const location = typeof m.location === 'string' ? m.location.trim() : ''
    for (const week of new Set(m.weeks)) {
      if (typeof week !== 'number' || !Number.isInteger(week) || week < 1 || week > 30) continue
      // 和课表导入使用同一套周次、星期及本地时钟规则，再用存储的绝对时刻精确匹配。
      const day = meetingDate(termStart, week, m.weekday)
      const key = intervalKey(atClock(day, m.start).getTime(), atClock(day, m.end).getTime())
      // 同一个时段匹配了多个 meeting，不能凭顺序猜测。
      locations.set(key, locations.has(key) ? '' : location)
    }
  }
  return locations
}

export function backfillPlanLocations(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT b.id, b.course_id, b.start_at, b.end_at, c.term_start, c.meetings, c.location AS default_location
    FROM plan_blocks b JOIN courses c ON c.id = b.course_id
    WHERE b.location IS NULL OR b.location = ''
  `).all() as unknown as UnlocatedBlock[]
  if (!rows.length) return
  const byCourse = new Map<string, Map<string, string>>()
  const update = db.prepare("UPDATE plan_blocks SET location = ? WHERE id = ? AND (location IS NULL OR location = '')")
  for (const row of rows) {
    let locations = byCourse.get(row.course_id)
    if (!locations) {
      locations = occurrenceLocations(row.term_start, row.meetings)
      byCourse.set(row.course_id, locations)
    }
    const key = intervalKey(Date.parse(row.start_at), Date.parse(row.end_at))
    const location = locations.get(key) || row.default_location.trim()
    if (location) update.run(location, row.id)
  }
}
