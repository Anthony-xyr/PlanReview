import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  BlockInput,
  EntryInput,
  Impact,
  OverrunReason,
  PlanBlock,
  Settings,
  StartTimerInput,
  StopResult,
  StopTimerInput,
  TimeEntry
} from '@shared/types'

interface BlockRow {
  id: string
  task_id: string | null
  title: string
  category_id: string | null
  task_title: string | null
  task_category: string | null
  task_status: PlanBlock['taskStatus']
  start_at: string
  end_at: string
  location?: string | null
  course_id: string | null
  course_location: string | null
}

interface EntryRow extends Omit<BlockRow, 'end_at' | 'task_status' | 'course_id' | 'course_location'> {
  plan_block_id: string | null
  end_at: string | null
  source: TimeEntry['source']
  note: string
  target_end_at: string | null
  planned_min: number | null
  extended_min: number
  overrun_reason: OverrunReason | null
}

const BLOCK_SELECT = `
  SELECT b.*, t.title AS task_title, t.category_id AS task_category, t.status AS task_status, c.location AS course_location
  FROM plan_blocks b LEFT JOIN tasks t ON t.id = b.task_id LEFT JOIN courses c ON c.id = b.course_id`

const ENTRY_SELECT = `
  SELECT e.*, t.title AS task_title, t.category_id AS task_category
  FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id`

// 关联任务时，标题和大类跟随任务
function toBlock(r: BlockRow): PlanBlock {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.task_title ?? r.title,
    categoryId: r.task_id ? r.task_category : r.category_id,
    taskStatus: r.task_status ?? null,
    startAt: r.start_at,
    endAt: r.end_at,
    courseId: r.course_id,
    location: r.location || r.course_location || ''
  }
}

function toEntry(r: EntryRow): TimeEntry {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.task_title ?? r.title,
    categoryId: r.task_id ? r.task_category : r.category_id,
    planBlockId: r.plan_block_id,
    startAt: r.start_at,
    endAt: r.end_at,
    source: r.source,
    note: r.note,
    targetEndAt: r.target_end_at,
    plannedMin: r.planned_min,
    extendedMin: r.extended_min,
    overrunReason: r.overrun_reason
  }
}

export const DEFAULT_SETTINGS: Settings = {
  dayStartHour: 5,
  sleepStart: '00:30',
  sleepEnd: '08:00',
  defaultSessionMin: 50,
  extendStepMin: 15,
  overrunAskRatio: 0.3,
  sleepLeadMin: 30,
  leaveEnabled: true,
  leaveTime: '22:00',
  leaveLeadMin: 10,
  blockReminders: true,
  strongSound: true,
  floatingEnabled: true,
  hideInFullscreen: true,
  hotkey: 'Alt+Shift+Space',
  closeToTray: true,
  launchAtLogin: false,
  dailyPicks: 2,
  inboxNagCount: 15,
  inboxNagDays: 7,
  weeklyReviewDay: 0,
  theme: 'system'
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** 'HH:MM' 在 from 之后（含）的下一次出现 */
export function nextClock(from: Date, clock: string): Date {
  const [h, m] = clock.split(':').map(Number)
  const d = new Date(from)
  d.setHours(h, m, 0, 0)
  if (d < from) d.setDate(d.getDate() + 1)
  return d
}

/** 当前所在或下一个睡眠窗口；inside 表示此刻已在窗口内 */
export function sleepWindow(now: Date, s: Pick<Settings, 'sleepStart' | 'sleepEnd'>): { start: Date; end: Date; inside: boolean } {
  const end = nextClock(now, s.sleepEnd)
  const startBeforeEnd = nextClock(new Date(end.getTime() - 86_400_000), s.sleepStart)
  if (startBeforeEnd <= now && now < end) return { start: startBeforeEnd, end, inside: true }
  const start = nextClock(now, s.sleepStart)
  return { start, end: nextClock(start, s.sleepEnd), inside: false }
}

const MIN_ENTRY_MS = 60_000

function iso(value: string, field: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`${field}格式不对`)
  return d.toISOString()
}

export class TimeRepo {
  /** now 可注入，方便测试 */
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date()
  ) {}

  private nowIso(): string {
    return this.now().toISOString()
  }

  private assertTask(taskId: string | null | undefined): void {
    if (taskId && !this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw new Error('任务不存在')
  }

  /** 统一处理任务 / 自由标题二选一 */
  private subject(input: { taskId?: string | null; title?: string; categoryId?: string | null }) {
    const taskId = input.taskId ?? null
    this.assertTask(taskId)
    const title = taskId ? '' : (input.title ?? '').trim()
    if (!taskId && !title) throw new Error('请选择任务或填写名称')
    return { taskId, title, categoryId: taskId ? null : (input.categoryId ?? null) }
  }

  private range(startAt: string, endAt: string): [string, string] {
    const s = iso(startAt, '开始时间')
    const e = iso(endAt, '结束时间')
    if (e <= s) throw new Error('结束时间要晚于开始时间')
    return [s, e]
  }

  // ---------- 计划 ----------

  listBlocks(from: string, to: string): PlanBlock[] {
    const rows = this.db
      .prepare(`${BLOCK_SELECT} WHERE b.start_at < ? AND b.end_at > ? ORDER BY b.start_at`)
      .all(iso(to, '结束'), iso(from, '开始')) as unknown as BlockRow[]
    return rows.map(toBlock)
  }

  getBlock(id: string): PlanBlock | null {
    const row = this.db.prepare(`${BLOCK_SELECT} WHERE b.id = ?`).get(id) as BlockRow | undefined
    return row ? toBlock(row) : null
  }

  createBlock(input: BlockInput): PlanBlock {
    const { taskId, title, categoryId } = this.subject(input)
    const [s, e] = this.range(input.startAt, input.endAt)
    const location = input.location?.trim() ?? ''
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO plan_blocks (id, task_id, title, category_id, start_at, end_at, location, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, taskId, title, categoryId, s, e, location, this.nowIso())
    // 排进计划的收件箱任务视为已整理
    if (taskId) this.db.prepare(`UPDATE tasks SET status = 'active' WHERE id = ? AND status = 'inbox'`).run(taskId)
    return this.getBlock(id)!
  }

  updateBlock(id: string, patch: Partial<BlockInput>): PlanBlock {
    const cur = this.getBlock(id)
    if (!cur) throw new Error('计划不存在')
    const merged = {
      taskId: patch.taskId !== undefined ? patch.taskId : cur.taskId,
      title: patch.title ?? (cur.taskId ? '' : cur.title),
      categoryId: patch.categoryId !== undefined ? patch.categoryId : cur.categoryId
    }
    const { taskId, title, categoryId } = this.subject(merged)
    const [s, e] = this.range(patch.startAt ?? cur.startAt, patch.endAt ?? cur.endAt)
    const location = patch.location !== undefined ? patch.location.trim() : cur.location
    this.db
      .prepare(
        `UPDATE plan_blocks SET task_id = ?, title = ?, category_id = ?, start_at = ?, end_at = ?, location = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(taskId, title, categoryId, s, e, location, this.nowIso(), id)
    return this.getBlock(id)!
  }

  deleteBlock(id: string): void {
    this.db.prepare('DELETE FROM plan_blocks WHERE id = ?').run(id)
  }

  // ---------- 实际记录 ----------

  listEntries(from: string, to: string): TimeEntry[] {
    const rows = this.db
      .prepare(
        `${ENTRY_SELECT} WHERE e.start_at < ? AND COALESCE(e.end_at, ?) > ? ORDER BY e.start_at`
      )
      .all(iso(to, '结束'), this.nowIso(), iso(from, '开始')) as unknown as EntryRow[]
    return rows.map(toEntry)
  }

  getEntry(id: string): TimeEntry | null {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as EntryRow | undefined
    return row ? toEntry(row) : null
  }

  running(): TimeEntry | null {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE e.end_at IS NULL LIMIT 1`).get() as EntryRow | undefined
    return row ? toEntry(row) : null
  }

  /** 实际记录不允许重叠：同一时刻只能在做一件事；进行中的计时算到此刻 */
  private assertNoOverlap(s: string, e: string, excludeId: string | null): void {
    const hit = this.db
      .prepare(
        `SELECT e.id, COALESCE(t.title, e.title) AS title FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id
         WHERE e.id IS NOT ? AND e.start_at < ? AND COALESCE(e.end_at, ?) > ? LIMIT 1`
      )
      .get(excludeId, e, this.nowIso(), s) as { title: string } | undefined
    if (hit) throw new Error(`和已有记录「${hit.title}」时间重叠`)
  }

  createEntry(input: EntryInput): TimeEntry {
    const { taskId, title, categoryId } = this.subject(input)
    const [s, e] = this.range(input.startAt, input.endAt)
    if (e > this.nowIso()) throw new Error('补录不能晚于现在')
    this.assertNoOverlap(s, e, null)
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO time_entries (id, task_id, title, category_id, start_at, end_at, source, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
      )
      .run(id, taskId, title, categoryId, s, e, input.note ?? '', this.nowIso())
    return this.getEntry(id)!
  }

  updateEntry(id: string, patch: Partial<EntryInput>): TimeEntry {
    const cur = this.getEntry(id)
    if (!cur) throw new Error('记录不存在')
    if (cur.endAt === null && patch.endAt !== undefined) throw new Error('正在计时的记录请先停止')
    const { taskId, title, categoryId } = this.subject({
      taskId: patch.taskId !== undefined ? patch.taskId : cur.taskId,
      title: patch.title ?? (cur.taskId ? '' : cur.title),
      categoryId: patch.categoryId !== undefined ? patch.categoryId : cur.categoryId
    })
    const s = iso(patch.startAt ?? cur.startAt, '开始时间')
    const e = cur.endAt === null ? null : this.range(s, patch.endAt ?? cur.endAt)[1]
    if (e && e > this.nowIso()) throw new Error('记录不能晚于现在')
    if (!e && s >= this.nowIso()) throw new Error('开始时间要早于现在')
    this.assertNoOverlap(s, e ?? this.nowIso(), id)
    const sets: [string, SQLInputValue][] = [
      ['task_id', taskId],
      ['title', title],
      ['category_id', categoryId],
      ['start_at', s],
      ['end_at', e],
      ['note', patch.note ?? cur.note],
      ['updated_at', this.nowIso()]
    ]
    this.db
      .prepare(`UPDATE time_entries SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...sets.map(([, v]) => v), id)
    return this.getEntry(id)!
  }

  deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM time_entries WHERE id = ?').run(id)
  }

  /** 开始计时；已有计时会先停止（切换任务） */
  start(input: StartTimerInput): TimeEntry {
    const { taskId, title, categoryId } = this.subject(input)
    const block = input.planBlockId ? this.getBlock(input.planBlockId) : null
    if (input.planBlockId && !block) throw new Error('计划不存在')
    if (this.running()) this.stop({})
    const nowDate = this.now()
    const now = nowDate.toISOString()
    this.assertNoOverlap(now, new Date(nowDate.getTime() + 1).toISOString(), null)

    // 本次时长：显式指定 > 计划块剩余 > 默认值；显式传 null 表示不设
    let planned = input.durationMin ?? null
    if (input.durationMin === undefined) {
      if (block && block.endAt > now) planned = Math.round((new Date(block.endAt).getTime() - nowDate.getTime()) / 60_000)
      else planned = this.getSettings().defaultSessionMin
    }
    if (planned != null && planned < 1) planned = null
    const target = planned != null ? new Date(nowDate.getTime() + planned * 60_000).toISOString() : null

    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO time_entries (id, task_id, title, category_id, plan_block_id, start_at, end_at, source, updated_at,
           target_end_at, planned_min)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'timer', ?, ?, ?)`
      )
      .run(id, taskId, title, categoryId, input.planBlockId ?? null, now, now, target, planned)
    if (taskId) this.db.prepare(`UPDATE tasks SET status = 'active' WHERE id = ? AND status = 'inbox'`).run(taskId)
    return this.getEntry(id)!
  }

  /** 结束本次投入。完成任务、写下一步是可选的，两者互相独立 */
  stop(input: StopTimerInput): StopResult {
    const cur = this.running()
    if (!cur) throw new Error('当前没有在计时')
    const now = this.now()
    const nowIso = now.toISOString()

    if (cur.taskId) {
      if (input.nextStep !== undefined)
        this.db.prepare('UPDATE tasks SET next_step = ?, updated_at = ? WHERE id = ?').run(input.nextStep.trim(), nowIso, cur.taskId)
      if (input.complete)
        this.db
          .prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND status != 'done'`)
          .run(nowIso, nowIso, cur.taskId)
    }

    if (now.getTime() - new Date(cur.startAt).getTime() < MIN_ENTRY_MS) {
      this.deleteEntry(cur.id)
      return { entry: null, discarded: true }
    }
    this.db
      .prepare('UPDATE time_entries SET end_at = ?, overrun_reason = ?, updated_at = ? WHERE id = ?')
      .run(nowIso, input.overrunReason ?? null, nowIso, cur.id)
    return { entry: this.getEntry(cur.id), discarded: false }
  }

  /** 实际是否明显超过本次计划（结束时据此询问原因） */
  isOverrun(entry: TimeEntry, at: Date = this.now()): boolean {
    if (!entry.plannedMin) return false
    const end = entry.endAt ? new Date(entry.endAt) : at
    const actual = (end.getTime() - new Date(entry.startAt).getTime()) / 60_000
    return actual > entry.plannedMin * (1 + this.getSettings().overrunAskRatio)
  }

  /** 延长本次投入：只推后本次目标，原计划不动 */
  extend(min: number): TimeEntry {
    if (!Number.isInteger(min) || min <= 0 || min > 600) throw new Error('延长时长不对')
    const cur = this.running()
    if (!cur) throw new Error('当前没有在计时')
    const now = this.now()
    const base = cur.targetEndAt && new Date(cur.targetEndAt) > now ? new Date(cur.targetEndAt) : now
    const target = new Date(base.getTime() + min * 60_000).toISOString()
    // 没设过本次时长时，把已做的时间当作原定时长，便于之后判断超时
    const planned = cur.plannedMin ?? Math.max(1, Math.round((now.getTime() - new Date(cur.startAt).getTime()) / 60_000))
    this.db
      .prepare('UPDATE time_entries SET target_end_at = ?, extended_min = extended_min + ?, planned_min = ?, updated_at = ? WHERE id = ?')
      .run(target, min, planned, now.toISOString(), cur.id)
    return this.getEntry(cur.id)!
  }

  /** 设定或取消本次目标结束时间 */
  setTarget(endAt: string | null): TimeEntry {
    const cur = this.running()
    if (!cur) throw new Error('当前没有在计时')
    const now = this.now()
    let target: string | null = null
    let planned: number | null = null
    if (endAt) {
      target = iso(endAt, '结束时间')
      if (target <= now.toISOString()) throw new Error('结束时间要晚于现在')
      planned = Math.round((new Date(target).getTime() - new Date(cur.startAt).getTime()) / 60_000)
    }
    this.db
      .prepare('UPDATE time_entries SET target_end_at = ?, planned_min = ?, extended_min = 0, updated_at = ? WHERE id = ?')
      .run(target, planned, now.toISOString(), cur.id)
    return this.getEntry(cur.id)!
  }

  setReason(id: string, reason: OverrunReason | null): TimeEntry {
    if (!this.getEntry(id)) throw new Error('记录不存在')
    this.db.prepare('UPDATE time_entries SET overrun_reason = ?, updated_at = ? WHERE id = ?').run(reason, this.nowIso(), id)
    return this.getEntry(id)!
  }

  /** 如果当前投入继续到 until：会挤占哪些计划、离睡眠还有多久、睡前还剩多少计划没做 */
  impact(until: Date, excludeBlockId: string | null = null): Impact {
    const now = this.now()
    const sleep = sleepWindow(now, this.getSettings())
    const sleepStart = sleep.inside ? now : sleep.start
    const upcoming = this.listBlocks(now.toISOString(), sleepStart.toISOString()).filter(
      (b) => b.id !== excludeBlockId && b.taskStatus !== 'done'
    )
    const squeezed = upcoming.filter((b) => b.startAt < until.toISOString()).map((b) => ({ title: b.title, startAt: b.startAt }))
    const remainingPlannedMin = Math.round(
      upcoming.reduce((s, b) => {
        const a = Math.max(new Date(b.startAt).getTime(), now.getTime())
        const e = Math.min(new Date(b.endAt).getTime(), sleepStart.getTime())
        return s + Math.max(0, e - a) / 60_000
      }, 0)
    )
    return {
      squeezed,
      minutesToSleep: Math.max(0, Math.round((sleepStart.getTime() - now.getTime()) / 60_000)),
      remainingPlannedMin
    }
  }

  // ---------- 设置 ----------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
    if (patch.dayStartHour !== undefined && !intIn(patch.dayStartHour, 0, 12)) throw new Error('一天的起点要在 0–12 点之间')
    for (const key of ['sleepStart', 'sleepEnd', 'leaveTime'] as const)
      if (patch[key] !== undefined && !CLOCK.test(patch[key]!)) throw new Error('时间格式应为 HH:MM')
    if (patch.defaultSessionMin != null && !intIn(patch.defaultSessionMin, 5, 600)) throw new Error('默认本次时长要在 5–600 分钟之间')
    if (patch.extendStepMin !== undefined && !intIn(patch.extendStepMin, 5, 120)) throw new Error('延长步长要在 5–120 分钟之间')
    if (patch.sleepLeadMin !== undefined && !intIn(patch.sleepLeadMin, 0, 180)) throw new Error('睡前提醒要在 0–180 分钟之间')
    if (patch.leaveLeadMin !== undefined && !intIn(patch.leaveLeadMin, 0, 120)) throw new Error('离开提醒提前量要在 0–120 分钟之间')
    if (patch.overrunAskRatio !== undefined && !(patch.overrunAskRatio >= 0 && patch.overrunAskRatio <= 3))
      throw new Error('超时比例要在 0–300% 之间')
    if (patch.hotkey !== undefined && !patch.hotkey.trim()) throw new Error('快捷键不能为空')
    if (patch.dailyPicks !== undefined && !intIn(patch.dailyPicks, 0, 3)) throw new Error('每日推送要在 0–3 条之间')
    if (patch.inboxNagCount !== undefined && !intIn(patch.inboxNagCount, 1, 200)) throw new Error('收件箱提示条数要在 1–200 之间')
    if (patch.inboxNagDays !== undefined && !intIn(patch.inboxNagDays, 1, 90)) throw new Error('收件箱提示天数要在 1–90 之间')
    if (patch.weeklyReviewDay !== undefined && !intIn(patch.weeklyReviewDay, 0, 6)) throw new Error('每周整理日不对')
    if (patch.theme !== undefined && !['system', 'light', 'dark'].includes(patch.theme)) throw new Error('外观设置不对')
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS && v !== undefined) upsert.run(k, JSON.stringify(v))
    return this.getSettings()
  }
}
