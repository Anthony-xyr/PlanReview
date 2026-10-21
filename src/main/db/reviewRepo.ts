import type { DatabaseSync } from 'node:sqlite'
import type {
  DailyReview,
  DailyReviewInput,
  DaySummary,
  Resurface,
  ResurfaceAction,
  Task
} from '@shared/types'
import { dateKey, dayOf, dayRange, overlapMin, shiftDay } from '@shared/time'
import type { Repo } from './repo'
import type { TimeRepo } from './timeRepo'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDay(day: string): void {
  if (!DAY_RE.test(day)) throw new Error('日期格式应为 YYYY-MM-DD')
}

/** 两个本地日期相差几天（b - a） */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

/**
 * 按权重不放回地抽 n 个：很久没碰过的权重更高，但新的也有机会。
 * rng 可注入，方便测试。
 */
export function weightedPick<T>(items: { item: T; weight: number }[], n: number, rng: () => number = Math.random): T[] {
  const pool = items.filter((x) => x.weight > 0)
  const out: T[] = []
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, x) => s + x.weight, 0)
    let r = rng() * total
    let i = 0
    while (i < pool.length - 1 && r >= pool[i].weight) r -= pool[i++].weight
    out.push(pool[i].item)
    pool.splice(i, 1)
  }
  return out
}

interface ReviewRow {
  day: string
  mood: number | null
  note: string
  tomorrow_task_id: string | null
  created_at: string
  updated_at: string
}

const toReview = (r: ReviewRow): DailyReview => ({
  day: r.day,
  mood: r.mood as DailyReview['mood'],
  note: r.note,
  tomorrowTaskId: r.tomorrow_task_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** 找回机制与每日复盘 */
export class ReviewRepo {
  constructor(
    private db: DatabaseSync,
    private repo: Repo,
    private time: TimeRepo,
    private now: () => Date = () => new Date(),
    private rng: () => number = Math.random
  ) {}

  // ---------- day_state ----------

  private getState<T>(day: string, key: string): T | null {
    const row = this.db.prepare('SELECT value FROM day_state WHERE day = ? AND key = ?').get(day, key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }

  private setState(day: string, key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO day_state (day, key, value) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = excluded.value')
      .run(day, key, JSON.stringify(value))
  }

  private today(): string {
    return dayOf(this.now(), this.time.getSettings().dayStartHour)
  }

  // ---------- 找回 ----------

  /** 随机推送的候选：没截止、没设下次查看、今天之后也没排进计划的未完成事项 */
  private pickCandidates(day: string): { task: Task; idleDays: number }[] {
    const { start } = dayRange(day, this.time.getSettings().dayStartHour)
    const planned = new Set(
      (this.db.prepare('SELECT DISTINCT task_id FROM plan_blocks WHERE task_id IS NOT NULL AND end_at > ?').all(start.toISOString()) as {
        task_id: string
      }[]).map((r) => r.task_id)
    )
    const lastTouched = new Map(
      (this.db
        .prepare(
          `SELECT t.id, MAX(t.updated_at, COALESCE((SELECT MAX(COALESCE(end_at, start_at)) FROM time_entries WHERE task_id = t.id), '')) AS touched
           FROM tasks t WHERE t.status IN ('inbox','active')`
        )
        .all() as { id: string; touched: string }[]).map((r) => [r.id, r.touched])
    )
    return this.repo
      .listTasks({ status: ['inbox', 'active'] })
      .filter((t) => !t.dueDate && !t.reviewDate && !planned.has(t.id))
      .map((task) => ({ task, idleDays: Math.max(0, daysBetween(dateKey(new Date(lastTouched.get(task.id) ?? task.updatedAt)), day)) }))
  }

  /** 很久没碰的更容易被抽到；封顶避免永远只抽最老的 */
  private drawPicks(day: string, exclude: Set<string>): string[] {
    const n = this.time.getSettings().dailyPicks
    if (n === 0) return []
    const pool = this.pickCandidates(day).filter((c) => !exclude.has(c.task.id))
    return weightedPick(pool.map((c) => ({ item: c.task.id, weight: 1 + Math.min(c.idleDays, 30) })), n, this.rng)
  }

  get(day: string): Resurface {
    assertDay(day)
    const cfg = this.time.getSettings()
    const open = this.repo.listTasks({ status: ['inbox', 'active'] })
    const due = open
      .filter((t) => t.reviewDate && t.reviewDate <= day)
      .sort((a, b) => a.reviewDate!.localeCompare(b.reviewDate!))

    const yesterday = shiftDay(day, -1)
    const prev = this.getReview(yesterday)
    const firstRaw = prev?.tomorrowTaskId ? this.repo.getTask(prev.tomorrowTaskId) : null
    const firstThing = firstRaw && (firstRaw.status === 'inbox' || firstRaw.status === 'active') ? firstRaw : null

    // 同一天内推送保持不变；处理过的不再显示。上次没抽到东西（比如当时还没有候选）就重新抽
    const skip = new Set([...due.map((t) => t.id), ...(firstThing ? [firstThing.id] : [])])
    let ids = this.getState<string[]>(day, 'picks')
    if (!ids?.length) {
      ids = this.drawPicks(day, skip)
      this.setState(day, 'picks', ids)
    }
    const handled = new Set(this.getState<string[]>(day, 'handled') ?? [])
    const byId = new Map(open.map((t) => [t.id, t]))
    const picks = ids
      .map((id) => byId.get(id))
      .filter((t): t is Task => !!t && !handled.has(t.id) && !t.reviewDate && t.id !== firstThing?.id)

    const inbox = open.filter((t) => t.status === 'inbox')
    const oldest = inbox.reduce((m, t) => (t.createdAt < m ? t.createdAt : m), this.now().toISOString())
    const oldestDays = inbox.length ? Math.max(0, daysBetween(dateKey(new Date(oldest)), dateKey(this.now()))) : 0
    const [y, m, d] = day.split('-').map(Number)
    const weekly = new Date(y, m - 1, d).getDay() === cfg.weeklyReviewDay
    const tidyNeeded = inbox.length > 0 && (inbox.length >= cfg.inboxNagCount || oldestDays >= cfg.inboxNagDays || weekly)

    return {
      due,
      picks,
      inbox: { count: inbox.length, oldestDays },
      tidyNeeded,
      tidyDismissed: this.getState<boolean>(day, 'tidy') === true,
      firstThing,
      yesterdayUnreviewed: !prev && this.hasActivity(yesterday)
    }
  }

  act(taskId: string, action: ResurfaceAction): Task {
    const task = this.repo.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const day = this.today()
    let result: Task
    switch (action.kind) {
      case 'keep':
        result = this.repo.updateTask(taskId, { status: task.status === 'inbox' ? 'active' : task.status, reviewDate: null })
        break
      case 'later':
        if (!Number.isInteger(action.days) || action.days < 1 || action.days > 365) throw new Error('天数要在 1–365 之间')
        result = this.repo.updateTask(taskId, { reviewDate: shiftDay(day, action.days) })
        break
      case 'clear':
        result = this.repo.updateTask(taskId, { reviewDate: null })
        break
      case 'drop':
        result = this.repo.updateTask(taskId, { status: 'dropped', reviewDate: null })
        break
      default:
        throw new Error('未知操作')
    }
    const handled = new Set(this.getState<string[]>(day, 'handled') ?? [])
    handled.add(taskId)
    this.setState(day, 'handled', [...handled])
    return result
  }

  reroll(day: string): Task[] {
    assertDay(day)
    const prev = new Set(this.getState<string[]>(day, 'picks') ?? [])
    const handled = new Set(this.getState<string[]>(day, 'handled') ?? [])
    const due = this.repo.listTasks({ status: ['inbox', 'active'] }).filter((t) => t.reviewDate && t.reviewDate <= day)
    // 尽量换成没出现过的；候选不够时再允许重复
    let ids = this.drawPicks(day, new Set([...prev, ...handled, ...due.map((t) => t.id)]))
    if (ids.length === 0) ids = this.drawPicks(day, new Set([...handled, ...due.map((t) => t.id)]))
    this.setState(day, 'picks', ids)
    return this.get(day).picks
  }

  dismissTidy(day: string): void {
    assertDay(day)
    this.setState(day, 'tidy', true)
  }

  // ---------- 每日复盘 ----------

  /** 这天有没有计划或实际记录（上课时段不算） */
  private hasActivity(day: string): boolean {
    const { start, end } = dayRange(day, this.time.getSettings().dayStartHour)
    const [s, e] = [start.toISOString(), end.toISOString()]
    const q = (sql: string) => !!this.db.prepare(sql).get(e, s)
    return (
      q('SELECT 1 FROM plan_blocks WHERE course_id IS NULL AND start_at < ? AND end_at > ? LIMIT 1') ||
      q('SELECT 1 FROM time_entries WHERE start_at < ? AND COALESCE(end_at, start_at) > ? LIMIT 1')
    )
  }

  getReview(day: string): DailyReview | null {
    const row = this.db.prepare('SELECT * FROM daily_reviews WHERE day = ?').get(day) as ReviewRow | undefined
    return row ? toReview(row) : null
  }

  summary(day: string): DaySummary {
    assertDay(day)
    const { start, end } = dayRange(day, this.time.getSettings().dayStartHour)
    const s = start.getTime()
    const e = end.getTime()
    const nowMs = this.now().getTime()
    const minOf = (a: string, b: string | null) =>
      overlapMin(new Date(a).getTime() / 60_000, (b ? new Date(b).getTime() : nowMs) / 60_000, s / 60_000, e / 60_000)

    const blocks = this.time.listBlocks(start.toISOString(), end.toISOString())
    const entries = this.time.listEntries(start.toISOString(), end.toISOString())

    const byCat = new Map<string | null, { plannedMin: number; actualMin: number }>()
    const bucket = (id: string | null) => byCat.get(id) ?? byCat.set(id, { plannedMin: 0, actualMin: 0 }).get(id)!
    for (const b of blocks) bucket(b.categoryId).plannedMin += minOf(b.startAt, b.endAt)
    for (const en of entries) bucket(en.categoryId).actualMin += minOf(en.startAt, en.endAt)

    // 记录和计划算「对得上」：从这个计划块开始计时，或同一任务，或同名的保留时段
    type Block = (typeof blocks)[number]
    type Entry = (typeof entries)[number]
    const matches = (b: Block, en: Entry) =>
      en.planBlockId === b.id || (b.taskId ? en.taskId === b.taskId : !en.taskId && en.title === b.title)

    // 已经过去、没完成、当天一点都没做的计划（上课时段不算）
    const skipped = blocks.filter(
      (b) => !b.courseId && new Date(b.endAt).getTime() <= nowMs && b.taskStatus !== 'done' && !entries.some((en) => matches(b, en))
    )
    // 已结束、对不上任何计划的记录
    const unplanned = entries.filter((en) => en.endAt && !blocks.some((b) => matches(b, en)))
    // 计时的记录有本次原定时长；补录的没有，就和对应的计划块比
    const ratio = this.time.getSettings().overrunAskRatio
    const needReason = entries.flatMap((en) => {
      if (!en.endAt || en.overrunReason) return []
      const block = en.plannedMin ? null : blocks.find((b) => matches(b, en))
      const planned = en.plannedMin ?? (block ? minOf(block.startAt, block.endAt) : 0)
      const actual = (new Date(en.endAt).getTime() - new Date(en.startAt).getTime()) / 60_000
      return planned > 0 && actual > planned * (1 + ratio) ? [{ entry: en, plannedMin: Math.round(planned) }] : []
    })

    const completed = this.repo
      .listTasks({ status: 'done' })
      .filter((t) => t.completedAt && t.completedAt >= start.toISOString() && t.completedAt < end.toISOString())

    const round = (n: number) => Math.round(n)
    return {
      day,
      plannedMin: round(blocks.reduce((sum, b) => sum + minOf(b.startAt, b.endAt), 0)),
      actualMin: round(entries.reduce((sum, en) => sum + minOf(en.startAt, en.endAt), 0)),
      byCategory: [...byCat]
        .map(([categoryId, v]) => ({ categoryId, plannedMin: round(v.plannedMin), actualMin: round(v.actualMin) }))
        .sort((a, b) => b.actualMin + b.plannedMin - (a.actualMin + a.plannedMin)),
      skipped,
      unplanned,
      needReason,
      completed,
      review: this.getReview(day)
    }
  }

  save(day: string, input: DailyReviewInput): DailyReview {
    assertDay(day)
    if (input.mood != null && !(Number.isInteger(input.mood) && input.mood >= 1 && input.mood <= 5)) throw new Error('感觉要在 1–5 之间')
    if (input.note !== undefined && input.note.length > 2000) throw new Error('备注太长了')
    if (input.tomorrowTaskId && !this.repo.getTask(input.tomorrowTaskId)) throw new Error('任务不存在')
    const cur = this.getReview(day)
    const nowIso = this.now().toISOString()
    const next = {
      mood: input.mood !== undefined ? input.mood : (cur?.mood ?? null),
      note: input.note !== undefined ? input.note.trim() : (cur?.note ?? ''),
      tomorrow: input.tomorrowTaskId !== undefined ? input.tomorrowTaskId : (cur?.tomorrowTaskId ?? null)
    }
    this.db
      .prepare(
        `INSERT INTO daily_reviews (day, mood, note, tomorrow_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET mood = excluded.mood, note = excluded.note,
           tomorrow_task_id = excluded.tomorrow_task_id, updated_at = excluded.updated_at`
      )
      .run(day, next.mood, next.note, next.tomorrow, nowIso, nowIso)
    return this.getReview(day)!
  }
}
