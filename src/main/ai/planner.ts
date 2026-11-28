import type { CaptureHabit, Category, PlanBlock, PlanReplan, PlanSuggestion, ReasoningEffort, SuggestedBlock, Task } from '@shared/types'
import { MAX_HABIT_CHARS } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage } from './client'
// 习惯编号的写法和换回 id 的规则两边一样，共用速记那边的
import { habitId, habitKey, sanitizeUsed } from './capture'

const MIN = 60_000
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export interface Gap {
  start: Date
  end: Date
}

/**
 * 可安排的空档：从 from 到 until（通常是现在到睡眠窗口开始），减去已有计划。
 * 短于 minMin 分钟的碎片丢掉。时刻对齐到 5 分钟。
 */
export function freeGaps(from: Date, until: Date, blocks: PlanBlock[], minMin = 20): Gap[] {
  const align = (t: number) => Math.ceil(t / (5 * MIN)) * 5 * MIN
  const busy = blocks
    .map((b) => [new Date(b.startAt).getTime(), new Date(b.endAt).getTime()] as const)
    .filter(([s, e]) => e > from.getTime() && s < until.getTime())
    .sort((a, b) => a[0] - b[0])
  const gaps: Gap[] = []
  let cur = align(from.getTime())
  for (const [s, e] of busy) {
    if (s > cur) gaps.push({ start: new Date(cur), end: new Date(s) })
    cur = Math.max(cur, e)
  }
  if (until.getTime() > cur) gaps.push({ start: new Date(cur), end: until })
  return gaps.filter((g) => (g.end.getTime() - g.start.getTime()) / MIN >= minMin)
}

export interface PlannerContext {
  day: string
  now: Date
  gaps: Gap[]
  blocks: PlanBlock[]
  tasks: Task[]
  categories: Category[]
  insights: string[]
  hint: string
  /** 启用的排程习惯，按这个顺序编号 h1、h2… */
  habits?: CaptureHabit[]
}

const enabledHabits = (c: PlannerContext) => (c.habits ?? []).filter((h) => h.enabled)

function basePlannerMessages(c: PlannerContext): ChatMessage[] {
  const cat = new Map(c.categories.map((x) => [x.id, x.name]))
  const taskLines = c.tasks.slice(0, 40).map((t) => {
    const left = t.estimateMin ? Math.max(0, t.estimateMin - t.spentMin) : null
    return `- id=${t.id}「${t.title}」[${t.categoryId ? (cat.get(t.categoryId) ?? '') : '未分类'}]${left != null ? ` 剩余估时 ${left} 分钟` : ' 未估时'}${t.dueDate ? ` 截止 ${t.dueDate}` : ''}${t.nextStep ? ` 下一步：${t.nextStep}` : ''}`
  })
  const system = `你帮一个大学生安排某一天剩下的时间。只能把任务放进给出的空档里，不能和已有安排重叠，不能超出空档。
原则：
- 学习和娱乐都是正常安排，不要把每个空档都塞满；块与块之间留出休息。
- 截止近的、有下一步的优先；长任务可以只排一部分（本次时长可以小于剩余估时）。
- 单块一般 25–90 分钟。
- 参考用户确认过的个人规律。
只输出一个 JSON 对象：
{"blocks":[{"taskId":"任务 id，或 null 表示休息/娱乐等保留时段","title":"taskId 为 null 时填名称","start":"HH:MM","end":"HH:MM","reason":"一句话说明为什么放这里"}],"notes":["一两句整体说明"]}`
  const user = [
    `日期：${c.day}，现在 ${hm(c.now)}`,
    `可安排的空档：${c.gaps.map((g) => `${hm(g.start)}–${hm(g.end)}`).join('、') || '没有'}`,
    `已有安排：${c.blocks.map((b) => `${hm(new Date(b.startAt))}–${hm(new Date(b.endAt))} ${b.title}`).join('；') || '没有'}`,
    `待办任务：\n${taskLines.join('\n') || '没有'}`,
    c.insights.length ? `个人规律：\n${c.insights.map((i) => `- ${i}`).join('\n')}` : '',
    c.hint.trim() ? `用户的要求：${c.hint.trim().slice(0, 500)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}


/** 无习惯分支保持主干提示词逐字一致；只有启用习惯时才增加编号与 usedHabits。 */
export function plannerMessages(c: PlannerContext): ChatMessage[] {
  return enabledHabits(c).length ? habitPlannerMessages(c) : basePlannerMessages(c)
}

export function normalizePlanFeedback(value: unknown): string[] {
  const notes = (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, 300)).filter(Boolean).slice(-5)
  if (!notes.length) throw new Error('写一句哪里不对')
  return notes
}

export function normalizePreviousPlan(value: unknown): SuggestedBlock[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('上一版草稿格式不对，最多 30 个时段')
  return value.map((item) => {
    const b = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    if ((b.taskId !== null && typeof b.taskId !== 'string') || typeof b.title !== 'string' ||
        typeof b.startAt !== 'string' || typeof b.endAt !== 'string' || typeof b.reason !== 'string' ||
        !Number.isFinite(Date.parse(b.startAt)) || !Number.isFinite(Date.parse(b.endAt)) ||
        Date.parse(b.endAt) <= Date.parse(b.startAt)) throw new Error('上一版草稿格式不对')
    return { taskId: b.taskId, title: b.title.slice(0, 200), startAt: b.startAt, endAt: b.endAt, reason: b.reason.slice(0, 200) }
  })
}

const BLOCK_FORMAT = `{"taskId":"任务 id，或 null 表示休息/吃饭/娱乐等保留时段","title":"taskId 为 null 时填名称","start":"HH:MM","end":"HH:MM","reason":"一句话说明为什么放这里"}`

function systemRules(c: PlannerContext): string {
  const habits = enabledHabits(c)
  return `你帮一个大学生安排某一天剩下的时间。只能把任务放进给出的空档里，不能和已有安排重叠，不能超出空档。
原则：
- 学习和娱乐都是正常安排，不要把每个空档都塞满；块与块之间留出休息。
- 截止近的、有下一步的优先；长任务可以只排一部分（本次时长可以小于剩余估时）。
- 单块一般 25–90 分钟。
- 参考用户确认过的个人规律。${
    habits.length
      ? `

这个用户的排程习惯（用户亲自确认过）：
${habits.map((h, i) => `${habitKey(i)}：${h.text}`).join('\n')}
冲突时的优先顺序：这次「用户的要求」 > 排程习惯 > 个人规律 > 上面的通用原则。`
      : ''
  }`
}

function contextLines(c: PlannerContext): string[] {
  const cat = new Map(c.categories.map((x) => [x.id, x.name]))
  const taskLines = c.tasks.slice(0, 40).map((t) => {
    const left = t.estimateMin ? Math.max(0, t.estimateMin - t.spentMin) : null
    return `- id=${t.id}「${t.title}」[${t.categoryId ? (cat.get(t.categoryId) ?? '') : '未分类'}]${left != null ? ` 剩余估时 ${left} 分钟` : ' 未估时'}${t.dueDate ? ` 截止 ${t.dueDate}` : ''}${t.nextStep ? ` 下一步：${t.nextStep}` : ''}`
  })
  return [
    `日期：${c.day}，现在 ${hm(c.now)}`,
    `可安排的空档：${c.gaps.map((g) => `${hm(g.start)}–${hm(g.end)}`).join('、') || '没有'}`,
    `已有安排：${c.blocks.map((b) => `${hm(new Date(b.startAt))}–${hm(new Date(b.endAt))} ${b.title}`).join('；') || '没有'}`,
    `待办任务：\n${taskLines.join('\n') || '没有'}`,
    c.insights.length ? `个人规律：\n${c.insights.map((i) => `- ${i}`).join('\n')}` : '',
    c.hint.trim() ? `用户的要求：${c.hint.trim().slice(0, 500)}` : ''
  ].filter(Boolean)
}

/** 有习惯时才让 AI 报告用到了哪几条 */
const usedField = (c: PlannerContext) => ((enabledHabits(c)).length ? `,"usedHabits":["这次实际影响了安排的习惯编号，如 h1；没用到就 []"]` : '')

function habitPlannerMessages(c: PlannerContext): ChatMessage[] {
  const system = `${systemRules(c)}
只输出一个 JSON 对象：
{"blocks":[${BLOCK_FORMAT}],"notes":["一两句整体说明"]${usedField(c)}}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: contextLines(c).join('\n\n') }
  ]
}

/** 纠正后重排：带上上一版草稿和用户历次的纠正，并让 AI 把纠正概括成一条排程习惯 */
export function replanMessages(c: PlannerContext, previous: SuggestedBlock[], feedback: string[]): ChatMessage[] {
  previous = normalizePreviousPlan(previous)
  feedback = normalizePlanFeedback(feedback)
  const system = `${systemRules(c)}

你之前给出过一版安排，用户指出了哪里不合 TA 的习惯。请按用户的纠正重新安排，并把这次纠正概括成一条以后排程也适用的习惯。
只输出一个 JSON 对象：
{"blocks":[${BLOCK_FORMAT}],"notes":["一两句整体说明"]${usedField(c)},"habit":"把纠正概括成一条通用的排程习惯，写清在什么情况下怎么排，以后别的日子也能照做，不要只针对今天的具体时刻和任务；不超过 60 个字。纠正只针对今天、不能推广时填空字符串","replaces":"新习惯和上面某条排程习惯说的是同一件事、或者互相矛盾时填那条的编号（如 h2），保存后会替换它；否则 null"}`
  const prev = previous.map((b) => `- ${hm(new Date(b.startAt))}–${hm(new Date(b.endAt))} ${b.title}${b.taskId ? '' : '（保留时段）'}`)
  const user = [
    ...contextLines(c),
    `你上次的安排：\n${prev.join('\n') || '没有排任何时段'}`,
    `用户的纠正：\n${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
  ].join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** 把 'HH:MM' 放到 day 那一天；早于一天起点的算到第二天（凌晨） */
function atDay(day: string, clock: string, dayStartHour: number): Date | null {
  const m = clock.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!m) return null
  const [y, mo, d] = day.split('-').map(Number)
  const h = Number(m[1])
  return new Date(y, mo - 1, d + (h < dayStartHour ? 1 : 0), h, Number(m[2]))
}

/** 只保留落在空档里、互不重叠、任务存在的块；其余丢掉并说明 */
export function sanitizePlan(raw: unknown, c: PlannerContext, dayStartHour: number): PlanSuggestion {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const taskById = new Map(c.tasks.map((t) => [t.id, t]))
  const notes = (Array.isArray(o.notes) ? o.notes : []).filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim().slice(0, 300)).slice(0, 3)
  const out: SuggestedBlock[] = []
  let dropped = 0
  for (const r of Array.isArray(o.blocks) ? o.blocks : []) {
    const b = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const s = typeof b.start === 'string' ? atDay(c.day, b.start, dayStartHour) : null
    const e = typeof b.end === 'string' ? atDay(c.day, b.end, dayStartHour) : null
    const taskId = typeof b.taskId === 'string' && taskById.has(b.taskId) ? b.taskId : null
    const title = taskId ? taskById.get(taskId)!.title : typeof b.title === 'string' ? b.title.trim().slice(0, 60) : ''
    const inGap = s && e && e > s && c.gaps.some((g) => s >= g.start && e <= g.end)
    const clash = s && e && out.some((x) => s < new Date(x.endAt) && e > new Date(x.startAt))
    if (!s || !e || !inGap || clash || !title || (e.getTime() - s.getTime()) / MIN < 10) {
      dropped++
      continue
    }
    out.push({ taskId, title, startAt: s.toISOString(), endAt: e.toISOString(), reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '' })
  }
  if (dropped) notes.push(`有 ${dropped} 个安排不在空档里或和别的冲突，已去掉`)
  return { day: c.day, blocks: out.sort((a, b) => a.startAt.localeCompare(b.startAt)), notes, habitIds: sanitizeUsed(raw, enabledHabits(c)) }
}

/** 重排的结果：除了草稿，还有 AI 提出的习惯和它要替换的旧习惯 */
export function sanitizeReplan(raw: unknown, c: PlannerContext, dayStartHour: number): PlanReplan {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const habit = typeof o.habit === 'string' ? o.habit.trim().replace(/\s+/g, ' ').slice(0, MAX_HABIT_CHARS) : ''
  return { ...sanitizePlan(raw, c, dayStartHour), habit, replacesId: habit ? habitId(o.replaces, enabledHabits(c)) : null }
}

const noGaps = (c: PlannerContext): PlanSuggestion => ({ day: c.day, blocks: [], notes: ['今天剩下的时间里没有空档了'], habitIds: [] })

export async function suggestPlan(ep: AiEndpoint, c: PlannerContext, dayStartHour: number, reasoningEffort: ReasoningEffort = 'low'): Promise<PlanSuggestion> {
  if (!c.gaps.length) return noGaps(c)
  const out = await chat(ep, plannerMessages(c), { json: true, timeoutMs: 90_000, temperature: 0.3, reasoningEffort })
  return sanitizePlan(extractJson(out), c, dayStartHour)
}

export async function replanDay(
  ep: AiEndpoint,
  c: PlannerContext,
  previous: SuggestedBlock[],
  feedback: string[],
  dayStartHour: number,
  reasoningEffort: ReasoningEffort = 'low'
): Promise<PlanReplan> {
  feedback = normalizePlanFeedback(feedback)
  previous = normalizePreviousPlan(previous)
  if (!c.gaps.length) return { ...noGaps(c), habit: '', replacesId: null }
  const out = await chat(ep, replanMessages(c, previous, feedback), { json: true, timeoutMs: 90_000, temperature: 0.3, reasoningEffort })
  return sanitizeReplan(extractJson(out), c, dayStartHour)
}
