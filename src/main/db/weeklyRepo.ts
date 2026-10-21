import type { DatabaseSync } from 'node:sqlite'
import type {
  DayMood,
  EstimateRow,
  Insight,
  InsightStatus,
  OverrunReason,
  ReviewMessage,
  Suggestion,
  WeekDay,
  WeeklyReport,
  WeeklyReview,
  WeekStats
} from '@shared/types'
import { dayRange, overlapMin, shiftDay } from '@shared/time'
import type { Repo } from './repo'
import type { TimeRepo } from './timeRepo'
import { nextClock } from './timeRepo'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 某天所在周的周一 */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const wd = (new Date(y, m - 1, d).getDay() + 6) % 7
  return shiftDay(day, -wd)
}

function assertWeek(weekStart: string): void {
  if (!DAY_RE.test(weekStart) || mondayOf(weekStart) !== weekStart) throw new Error('周的起点应为周一（YYYY-MM-DD）')
}

/** 毫秒区间 [a, b) 和 [c, d) 重叠的分钟数（overlapMin 与单位无关，传毫秒得毫秒） */
const overlapMs = (a: number, b: number, c: number, d: number) => overlapMin(a, b, c, d) / 60_000

/** 计时与睡眠窗口 [start, end) 的重叠：窗口可能跨零点，同一天内最多碰到两段 */
function sleepOverlap(s: number, e: number, dayStart: Date, dayEnd: Date, sleepStart: string, sleepEnd: string): number {
  let total = 0
  // 从这一天起点前一天开始找，覆盖跨零点的窗口
  let from = new Date(dayStart.getTime() - 86_400_000)
  for (let i = 0; i < 3; i++) {
    const ws = nextClock(from, sleepStart)
    const we = nextClock(ws, sleepEnd)
    const a = Math.max(ws.getTime(), dayStart.getTime())
    const b = Math.min(we.getTime(), dayEnd.getTime())
    if (b > a) total += overlapMs(s, e, a, b)
    from = new Date(ws.getTime() + 60_000)
  }
  return total
}

interface WeeklyRow {
  week_start: string
  report: string | null
  model: string
  created_at: string
  updated_at: string
}

interface InsightRow {
  id: string
  text: string
  evidence: string
  status: InsightStatus
  source_week: string | null
  created_at: string
  updated_at: string
}

const toInsight = (r: InsightRow): Insight => ({
  id: r.id,
  text: r.text,
  evidence: r.evidence,
  status: r.status,
  sourceWeek: r.source_week,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export class WeeklyRepo {
  constructor(
    private db: DatabaseSync,
    private repo: Repo,
    private time: TimeRepo,
    private now: () => Date = () => new Date()
  ) {}

  stats(weekStart: string): WeekStats {
    assertWeek(weekStart)
    const cfg = this.time.getSettings()
    const nowMs = this.now().getTime()
    const weekFrom = dayRange(weekStart, cfg.dayStartHour).start
    const weekTo = dayRange(shiftDay(weekStart, 6), cfg.dayStartHour).end
    const blocks = this.time.listBlocks(weekFrom.toISOString(), weekTo.toISOString()).filter((b) => !b.courseId)
    const entries = this.time.listEntries(weekFrom.toISOString(), weekTo.toISOString())
    const endMs = (iso: string | null) => (iso ? new Date(iso).getTime() : nowMs)
    const moods = new Map(
      (this.db.prepare('SELECT day, mood FROM daily_reviews WHERE day >= ? AND day <= ?').all(weekStart, shiftDay(weekStart, 6)) as {
        day: string
        mood: number | null
      }[]).map((r) => [r.day, r.mood as DayMood | null])
    )

    const catPlan = new Map<string | null, number>()
    const catAct = new Map<string | null, number>()
    const add = (m: Map<string | null, number>, k: string | null, v: number) => m.set(k, (m.get(k) ?? 0) + v)

    const days: WeekDay[] = []
    for (let i = 0; i < 7; i++) {
      const day = shiftDay(weekStart, i)
      const { start, end } = dayRange(day, cfg.dayStartHour)
      const [s, e] = [start.getTime(), end.getTime()]
      const byCategory: Record<string, number> = {}
      let planned = 0
      let actual = 0
      let sleepMin = 0
      let lastEnd = 0
      for (const b of blocks) {
        const m = overlapMs(new Date(b.startAt).getTime(), new Date(b.endAt).getTime(), s, e)
        planned += m
        add(catPlan, b.categoryId, m)
      }
      for (const en of entries) {
        const a = new Date(en.startAt).getTime()
        const z = endMs(en.endAt)
        const m = overlapMs(a, z, s, e)
        if (m <= 0) continue
        actual += m
        add(catAct, en.categoryId, m)
        const key = en.categoryId ?? ''
        byCategory[key] = Math.round((byCategory[key] ?? 0) + m)
        sleepMin += sleepOverlap(a, z, start, end, cfg.sleepStart, cfg.sleepEnd)
        lastEnd = Math.max(lastEnd, Math.min(z, e))
      }
      days.push({
        day,
        plannedMin: Math.round(planned),
        actualMin: Math.round(actual),
        byCategory,
        sleepWindowMin: Math.round(sleepMin),
        lastEndAt: lastEnd ? new Date(lastEnd).toISOString() : null,
        mood: moods.get(day) ?? null
      })
    }

    // 计划兑现：每个计划块里，对得上的实际记录覆盖了多少
    let plannedTotal = 0
    let fulfilled = 0
    for (const b of blocks) {
      const bs = new Date(b.startAt).getTime()
      const be = new Date(b.endAt).getTime()
      if (bs >= nowMs) continue // 还没到的计划不算
      const len = (Math.min(be, nowMs) - bs) / 60_000
      plannedTotal += len
      const matched = entries.filter((en) => en.planBlockId === b.id || (b.taskId ? en.taskId === b.taskId : !en.taskId && en.title === b.title))
      fulfilled += Math.min(len, matched.reduce((sum, en) => sum + overlapMs(new Date(en.startAt).getTime(), endMs(en.endAt), bs, be), 0))
    }

    // 估时偏差：本周完成、有估时的任务
    const [fromIso, toIso] = [weekFrom.toISOString(), weekTo.toISOString()]
    const doneTasks = this.repo.listTasks({ status: 'done' }).filter((t) => t.completedAt && t.completedAt >= fromIso && t.completedAt < toIso)
    const estimates: EstimateRow[] = doneTasks
      .filter((t) => t.estimateMin && t.estimateMin > 0 && t.spentMin > 0)
      .map((t) => ({ taskId: t.id, title: t.title, categoryId: t.categoryId, estimateMin: t.estimateMin!, spentMin: t.spentMin }))

    // 超时原因：本周结束的、明显超时的记录。计时的和本次原定时长比；补录的和对应计划块比（与每日复盘一致）
    const reasonMap = new Map<OverrunReason | 'none', { count: number; minutes: number }>()
    for (const en of entries) {
      if (!en.endAt) continue
      const block = en.plannedMin ? null : blocks.find((b) => en.planBlockId === b.id || (b.taskId ? en.taskId === b.taskId : !en.taskId && en.title === b.title))
      const planned = en.plannedMin ?? (block ? (new Date(block.endAt).getTime() - new Date(block.startAt).getTime()) / 60_000 : 0)
      const actual = (new Date(en.endAt).getTime() - new Date(en.startAt).getTime()) / 60_000
      if (!(planned > 0 && actual > planned * (1 + cfg.overrunAskRatio))) continue
      const k = en.overrunReason ?? 'none'
      const over = actual - planned
      const cur = reasonMap.get(k) ?? { count: 0, minutes: 0 }
      reasonMap.set(k, { count: cur.count + 1, minutes: cur.minutes + Math.max(0, over) })
    }

    const count = (sql: string, ...p: string[]) => (this.db.prepare(sql).get(...p) as { n: number }).n
    const cats = new Set([...catPlan.keys(), ...catAct.keys()])
    return {
      weekStart,
      days,
      plannedMin: days.reduce((s, d) => s + d.plannedMin, 0),
      actualMin: days.reduce((s, d) => s + d.actualMin, 0),
      fulfilment: plannedTotal > 0 ? Math.min(1, fulfilled / plannedTotal) : null,
      byCategory: [...cats]
        .map((categoryId) => ({ categoryId, plannedMin: Math.round(catPlan.get(categoryId) ?? 0), actualMin: Math.round(catAct.get(categoryId) ?? 0) }))
        .sort((a, b) => b.actualMin - a.actualMin || b.plannedMin - a.plannedMin),
      estimates,
      reasons: [...reasonMap].map(([reason, v]) => ({ reason, count: v.count, minutes: Math.round(v.minutes) })).sort((a, b) => b.count - a.count),
      completed: doneTasks.length,
      created: count('SELECT COUNT(*) AS n FROM tasks WHERE created_at >= ? AND created_at < ?', fromIso, toIso),
      spinOffs: count('SELECT COUNT(*) AS n FROM tasks WHERE source_task_id IS NOT NULL AND created_at >= ? AND created_at < ?', fromIso, toIso),
      reviewedDays: moods.size
    }
  }

  // ---------- 周复盘报告与追问 ----------

  get(weekStart: string): WeeklyReview | null {
    assertWeek(weekStart)
    const row = this.db.prepare('SELECT * FROM weekly_reviews WHERE week_start = ?').get(weekStart) as WeeklyRow | undefined
    if (!row) return null
    const messages = (this.db
      .prepare('SELECT id, role, content, created_at FROM review_messages WHERE week_start = ? ORDER BY created_at, rowid')
      .all(weekStart) as { id: string; role: ReviewMessage['role']; content: string; created_at: string }[]).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at
    }))
    return {
      weekStart,
      report: row.report ? (JSON.parse(row.report) as WeeklyReport) : null,
      model: row.model,
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  /** 保存新报告：覆盖旧报告并清空追问；报告里的画像候选写进 insights（待确认） */
  saveReport(weekStart: string, report: WeeklyReport, model: string, insightDrafts: { text: string; evidence: string }[]): WeeklyReview {
    assertWeek(weekStart)
    const nowIso = this.now().toISOString()
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO weekly_reviews (week_start, report, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(week_start) DO UPDATE SET report = excluded.report, model = excluded.model, updated_at = excluded.updated_at`
        )
        .run(weekStart, JSON.stringify(report), model, nowIso, nowIso)
      this.db.prepare('DELETE FROM review_messages WHERE week_start = ?').run(weekStart)
      // 同一周重新生成时，旧的待确认候选作废；已确认 / 已拒绝的保留
      this.db.prepare(`DELETE FROM insights WHERE source_week = ? AND status = 'pending'`).run(weekStart)
      const existing = new Set(this.listInsights().map((i) => i.text))
      const ins = this.db.prepare(
        `INSERT INTO insights (id, text, evidence, status, source_week, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`
      )
      for (const d of insightDrafts) if (!existing.has(d.text)) ins.run(crypto.randomUUID(), d.text, d.evidence, weekStart, nowIso, nowIso)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return this.get(weekStart)!
  }

  addMessage(weekStart: string, role: ReviewMessage['role'], content: string): ReviewMessage {
    if (!this.get(weekStart)) throw new Error('这一周还没有复盘报告')
    const m = { id: crypto.randomUUID(), role, content, createdAt: this.now().toISOString() }
    this.db.prepare('INSERT INTO review_messages (id, week_start, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(m.id, weekStart, role, content, m.createdAt)
    return m
  }

  private setSuggestionStatus(weekStart: string, id: string, status: Suggestion['status']): Suggestion {
    const r = this.get(weekStart)
    const s = r?.report?.suggestions.find((x) => x.id === id)
    if (!r?.report || !s) throw new Error('建议不存在')
    if (s.status !== 'open') throw new Error('这条建议已经处理过了')
    s.status = status
    this.db.prepare('UPDATE weekly_reviews SET report = ?, updated_at = ? WHERE week_start = ?').run(JSON.stringify(r.report), this.now().toISOString(), weekStart)
    return s
  }

  /** 采纳建议：执行改动，再标记为已采纳。改动失败则不标记 */
  apply(weekStart: string, id: string): WeeklyReview {
    const s = this.get(weekStart)?.report?.suggestions.find((x) => x.id === id)
    if (!s) throw new Error('建议不存在')
    if (s.status !== 'open') throw new Error('这条建议已经处理过了')
    const a = s.action
    if (a.kind === 'setting') this.time.updateSettings({ [a.key]: a.value })
    else if (a.kind === 'estimate') {
      const t = this.repo.getTask(a.taskId)
      if (!t) throw new Error('任务已经不存在了')
      this.repo.updateTask(a.taskId, { estimateMin: a.estimateMin })
    } else if (a.kind === 'insight') this.addInsight(a.text, s.evidence, 'accepted', weekStart)
    this.setSuggestionStatus(weekStart, id, 'applied')
    return this.get(weekStart)!
  }

  dismiss(weekStart: string, id: string): WeeklyReview {
    this.setSuggestionStatus(weekStart, id, 'dismissed')
    return this.get(weekStart)!
  }

  // ---------- 个人画像 ----------

  listInsights(): Insight[] {
    return (this.db.prepare(`SELECT * FROM insights ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, created_at DESC`).all() as unknown as InsightRow[]).map(toInsight)
  }

  private addInsight(text: string, evidence: string, status: InsightStatus, sourceWeek: string | null): Insight {
    const t = text.trim()
    if (!t) throw new Error('内容不能为空')
    const dup = this.listInsights().find((i) => i.text === t)
    if (dup) return dup.status === status ? dup : this.updateInsight(dup.id, { status })
    const nowIso = this.now().toISOString()
    const id = crypto.randomUUID()
    this.db.prepare('INSERT INTO insights (id, text, evidence, status, source_week, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, t, evidence, status, sourceWeek, nowIso, nowIso)
    return this.listInsights().find((i) => i.id === id)!
  }

  updateInsight(id: string, patch: { status?: InsightStatus; text?: string }): Insight {
    const cur = this.listInsights().find((i) => i.id === id)
    if (!cur) throw new Error('画像条目不存在')
    if (patch.status && !['pending', 'accepted', 'rejected'].includes(patch.status)) throw new Error('状态不对')
    const text = patch.text !== undefined ? patch.text.trim() : cur.text
    if (!text) throw new Error('内容不能为空')
    if (text.length > 300) throw new Error('内容太长了')
    this.db.prepare('UPDATE insights SET text = ?, status = ?, updated_at = ? WHERE id = ?').run(text, patch.status ?? cur.status, this.now().toISOString(), id)
    return this.listInsights().find((i) => i.id === id)!
  }

  removeInsight(id: string): void {
    this.db.prepare('DELETE FROM insights WHERE id = ?').run(id)
  }

  /** 给 AI 看的已确认画像 */
  acceptedInsights(): string[] {
    return this.listInsights()
      .filter((i) => i.status === 'accepted')
      .map((i) => i.text)
  }
}
