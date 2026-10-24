import type { Category, PlanBlock, PlanSuggestion, SuggestedBlock, Task } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage } from './client'

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
}

export function plannerMessages(c: PlannerContext): ChatMessage[] {
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
  return { day: c.day, blocks: out.sort((a, b) => a.startAt.localeCompare(b.startAt)), notes }
}

export async function suggestPlan(ep: AiEndpoint, c: PlannerContext, dayStartHour: number, reasoningEffort: 'low' | 'medium' | 'high' = 'low'): Promise<PlanSuggestion> {
  if (!c.gaps.length) return { day: c.day, blocks: [], notes: ['今天剩下的时间里没有空档了'] }
  const out = await chat(ep, plannerMessages(c), { json: true, timeoutMs: 90_000, temperature: 0.3, reasoningEffort })
  return sanitizePlan(extractJson(out), c, dayStartHour)
}
