import type { DatabaseSync } from 'node:sqlite'
import type { Course, CourseMeeting, ScheduleDraft } from '@shared/types'

const CATEGORY_NAME = '课程'
const CATEGORY_COLOR = '#4a3aa7'

interface CourseRow {
  id: string
  name: string
  location: string
  teacher: string
  meetings: string
}

/** termStart 所在周的周一 + (week-1) 周 + (weekday-1) 天，本地时间 */
export function meetingDate(termStart: string, week: number, weekday: number): Date {
  const [y, m, d] = termStart.split('-').map(Number)
  const base = new Date(y, m - 1, d)
  const mondayOffset = (base.getDay() + 6) % 7
  return new Date(y, m - 1, d - mondayOffset + (week - 1) * 7 + (weekday - 1))
}

export function atClock(day: Date, clock: string): Date {
  const [h, mi] = clock.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi)
}

export class CourseRepo {
  constructor(private db: DatabaseSync) {}

  list(): Course[] {
    const rows = this.db.prepare('SELECT * FROM courses ORDER BY name').all() as unknown as CourseRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, location: r.location, teacher: r.teacher, meetings: JSON.parse(r.meetings) as CourseMeeting[] }))
  }

  /** 课程用一个专门的大类，方便在时间轴上一眼认出来 */
  private categoryId(): string {
    const row = this.db.prepare('SELECT id FROM categories WHERE name = ?').get(CATEGORY_NAME) as { id: string } | undefined
    if (row) return row.id
    const id = crypto.randomUUID()
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
    this.db
      .prepare('INSERT INTO categories (id, name, color, sort, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, CATEGORY_NAME, CATEGORY_COLOR, n, new Date().toISOString())
    return id
  }

  commit(draft: ScheduleDraft, replace: boolean): { courses: number; blocks: number } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.termStart)) throw new Error('请填写第一周的日期')
    if (!draft.courses.length) throw new Error('没有可导入的课程')
    for (const c of draft.courses) {
      if (!c.name.trim()) throw new Error('有课程没有名字')
      for (const m of c.meetings) {
        if (!(m.weekday >= 1 && m.weekday <= 7) || !/^\d{2}:\d{2}$/.test(m.start) || !/^\d{2}:\d{2}$/.test(m.end) || m.start >= m.end)
          throw new Error(`「${c.name}」的上课时间不对`)
        if (!m.weeks.length) throw new Error(`「${c.name}」没有填上课周次`)
      }
    }

    this.db.exec('BEGIN')
    try {
      if (replace) this.db.exec('DELETE FROM courses')
      const cat = this.categoryId()
      const now = new Date().toISOString()
      const insCourse = this.db.prepare('INSERT INTO courses (id, name, location, teacher, meetings, term_start, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const insBlock = this.db.prepare(
        'INSERT INTO plan_blocks (id, task_id, title, category_id, start_at, end_at, updated_at, course_id) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)'
      )
      let blocks = 0
      for (const c of draft.courses) {
        const id = crypto.randomUUID()
        insCourse.run(id, c.name.trim(), c.location.trim(), c.teacher.trim(), JSON.stringify(c.meetings), draft.termStart, now)
        for (const m of c.meetings)
          for (const w of m.weeks) {
            const day = meetingDate(draft.termStart, w, m.weekday)
            insBlock.run(crypto.randomUUID(), c.name.trim(), cat, atClock(day, m.start).toISOString(), atClock(day, m.end).toISOString(), now, id)
            blocks++
          }
      }
      this.db.exec('COMMIT')
      return { courses: draft.courses.length, blocks }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  removeAll(): { courses: number; blocks: number } {
    const { b } = this.db.prepare('SELECT COUNT(*) AS b FROM plan_blocks WHERE course_id IS NOT NULL').get() as { b: number }
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }
    this.db.exec('DELETE FROM courses')
    return { courses: c, blocks: b }
  }
}
