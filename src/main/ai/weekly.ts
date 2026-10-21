import type { Category, Settings, Suggestion, SuggestionAction, Task, WeeklyReport, WeekStats } from '@shared/types'
import { OVERRUN_REASONS } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage } from './client'

/** 写进上下文的每日复盘 */
export interface DayNote {
  day: string
  mood: number | null
  note: string
}

export interface WeekContext {
  stats: WeekStats
  notes: DayNote[]
  categories: Category[]
  settings: Settings
  /** 还没完成的任务，用于估时类建议 */
  openTasks: Task[]
  insights: string[]
}

const WD = '一二三四五六日'
const fm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`)
const pct = (x: number) => `${Math.round(x * 100)}%`

/** 把一周的数据写成给模型看的文字。只放统计和用户写的复盘，不放无关的明细 */
export function weekContextText(c: WeekContext): string {
  const cat = new Map(c.categories.map((x) => [x.id, x.name]))
  const name = (id: string | null) => (id ? (cat.get(id) ?? '已删除的大类') : '未分类')
  const s = c.stats
  const lines: string[] = []
  lines.push(`周期：${s.weekStart} 起的一周（周一到周日，一天从 ${c.settings.dayStartHour}:00 算起）`)
  lines.push(`睡眠窗口：${c.settings.sleepStart}–${c.settings.sleepEnd}；自习室离开时间：${c.settings.leaveEnabled ? c.settings.leaveTime : '未设置'}`)
  lines.push(`当前设置：直接开始计时的默认时长 ${c.settings.defaultSessionMin ?? '不设'} 分钟；每次延长 ${c.settings.extendStepMin} 分钟；睡前 ${c.settings.sleepLeadMin} 分钟开始提醒`)
  lines.push('')
  lines.push(`合计：计划 ${fm(s.plannedMin)}，实际 ${fm(s.actualMin)}，计划兑现率 ${s.fulfilment == null ? '无计划' : pct(s.fulfilment)}`)
  lines.push(`完成任务 ${s.completed} 个，新建 ${s.created} 个，其中因范围扩大拆出的延伸任务 ${s.spinOffs} 个；写了每日复盘 ${s.reviewedDays} 天`)
  lines.push('')
  lines.push('每天（实际 / 计划；睡眠窗口内的活动；最后一条记录结束时间；心情 1–5）：')
  s.days.forEach((d, i) => {
    const cats = Object.entries(d.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${name(k || null)} ${fm(v)}`)
      .join('、')
    const last = d.lastEndAt ? new Date(d.lastEndAt).toTimeString().slice(0, 5) : '—'
    lines.push(
      `- 周${WD[i]} ${d.day}：实际 ${fm(d.actualMin)} / 计划 ${fm(d.plannedMin)}${cats ? `（${cats}）` : ''}；睡眠窗口内 ${fm(d.sleepWindowMin)}；最后结束 ${last}；心情 ${d.mood ?? '未填'}`
    )
  })
  lines.push('')
  lines.push('按大类（实际 / 计划）：')
  for (const r of s.byCategory) lines.push(`- ${name(r.categoryId)}：${fm(r.actualMin)} / ${fm(r.plannedMin)}`)
  if (s.estimates.length) {
    lines.push('')
    lines.push('本周完成且有估时的任务（实际 / 估时）：')
    for (const e of s.estimates.slice(0, 20)) lines.push(`- 「${e.title}」[${name(e.categoryId)}]：${fm(e.spentMin)} / ${fm(e.estimateMin)}（${pct(e.spentMin / e.estimateMin)}）`)
  }
  if (s.reasons.length) {
    lines.push('')
    lines.push('明显超时的记录及原因（次数，合计超出）：')
    const label = (r: string) => OVERRUN_REASONS.find((x) => x.value === r)?.label ?? '未标注'
    for (const r of s.reasons) lines.push(`- ${label(r.reason)}：${r.count} 次，超出 ${fm(r.minutes)}`)
  }
  const notes = c.notes.filter((n) => n.note.trim())
  if (notes.length) {
    lines.push('')
    lines.push('用户自己写的每日复盘：')
    for (const n of notes) lines.push(`- ${n.day}：${n.note.trim().slice(0, 300)}`)
  }
  const open = c.openTasks.filter((t) => t.estimateMin).slice(0, 30)
  if (open.length) {
    lines.push('')
    lines.push('还没完成、有估时的任务（可用于估时建议，id 用于 action）：')
    for (const t of open) lines.push(`- id=${t.id}「${t.title}」[${name(t.categoryId)}] 估时 ${fm(t.estimateMin!)}，已投入 ${fm(t.spentMin)}`)
  }
  if (c.insights.length) {
    lines.push('')
    lines.push('用户之前确认过的个人规律（可以引用，也可以指出本周与之不符）：')
    for (const i of c.insights) lines.push(`- ${i}`)
  }
  return lines.join('\n')
}

export const WEEKLY_SYSTEM = `你是一个陪大学生做每周复盘的助手。用户同时需要学习和娱乐，两者都是正常安排。
你的原则：
- 只根据给出的数据说话。每条观察和建议都要写明依据：引用具体的日期、数字或用户自己写的话。数据不足就直说，不要编。
- 超时不等于低效。区分估时偏差、范围扩大、受干扰、记录错误和原因不明，不要把现象归结为懒惰或能力不足。
- 目标是帮用户安排好生活、及时收尾，不是追求更长的学习时间。不要劝用户减少娱乐，除非数据显示它挤占了睡眠或计划内的事。
- 语气平实、具体，像朋友，不说教，不用感叹号。
- 用户保留决定权：所有改动都只是建议。

只输出一个 JSON 对象，不要任何解释，格式：
{
  "summary": "两三句话概括这一周",
  "wins": ["做得好的地方，最多 3 条"],
  "patterns": ["观察到的规律，每条带依据，最多 4 条"],
  "suggestions": [
    {
      "title": "一句话建议",
      "evidence": "依据：具体日期 / 数字",
      "action": 以下之一：
        {"kind":"none"} 只是建议，没有可执行的改动
        {"kind":"setting","key":"defaultSessionMin"|"extendStepMin"|"sleepLeadMin","value":整数分钟}
        {"kind":"setting","key":"leaveTime"|"sleepStart","value":"HH:MM"}
        {"kind":"estimate","taskId":"上面列出的 id","estimateMin":整数分钟}
        {"kind":"insight","text":"值得长期记住的个人规律，一句话"}
    }
  ],
  "insights": [{"text":"候选的长期个人规律，一句话","evidence":"依据"}]
}
suggestions 最多 4 条，按价值排序；insights 最多 2 条，只写有至少两次数据支撑的规律。`

export function weeklyMessages(context: string): ChatMessage[] {
  return [
    { role: 'system', content: WEEKLY_SYSTEM },
    { role: 'user', content: `这是我这周的数据：\n\n${context}` }
  ]
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strList = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, n) : [])

/** 改动只接受白名单里的种类和范围；不合规的降级为「只是建议」，绝不信任模型输出 */
export function sanitizeAction(raw: unknown, openTaskIds: Set<string>): SuggestionAction {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null)
  if (a.kind === 'setting') {
    if (a.key === 'defaultSessionMin') { const v = int(a.value, 5, 600); if (v !== null) return { kind: 'setting', key: a.key, value: v } }
    if (a.key === 'extendStepMin') { const v = int(a.value, 5, 120); if (v !== null) return { kind: 'setting', key: a.key, value: v } }
    if (a.key === 'sleepLeadMin') { const v = int(a.value, 0, 180); if (v !== null) return { kind: 'setting', key: a.key, value: v } }
    if ((a.key === 'leaveTime' || a.key === 'sleepStart') && typeof a.value === 'string' && CLOCK.test(a.value))
      return { kind: 'setting', key: a.key, value: a.value }
  }
  if (a.kind === 'estimate' && typeof a.taskId === 'string' && openTaskIds.has(a.taskId)) {
    const v = int(a.estimateMin, 5, 100 * 60)
    if (v !== null) return { kind: 'estimate', taskId: a.taskId, estimateMin: v }
  }
  if (a.kind === 'insight') {
    const text = str(a.text, 200)
    if (text) return { kind: 'insight', text }
  }
  return { kind: 'none' }
}

export function sanitizeWeekly(raw: unknown, openTaskIds: Set<string>): { report: WeeklyReport; insights: { text: string; evidence: string }[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const suggestions: Suggestion[] = (Array.isArray(o.suggestions) ? o.suggestions : [])
    .map((s) => (s && typeof s === 'object' ? s : {}) as Record<string, unknown>)
    .filter((s) => str(s.title))
    .slice(0, 4)
    .map((s) => ({
      id: crypto.randomUUID(),
      title: str(s.title, 120),
      evidence: str(s.evidence),
      action: sanitizeAction(s.action, openTaskIds),
      status: 'open' as const
    }))
  const insights = (Array.isArray(o.insights) ? o.insights : [])
    .map((i) => (i && typeof i === 'object' ? i : {}) as Record<string, unknown>)
    .map((i) => ({ text: str(i.text, 200), evidence: str(i.evidence) }))
    .filter((i) => i.text)
    .slice(0, 2)
  const summary = str(o.summary, 600)
  if (!summary && !suggestions.length) throw new Error('AI 没有给出有效的复盘，请重试')
  return {
    report: { summary, wins: strList(o.wins, 3), patterns: strList(o.patterns, 4), suggestions },
    insights
  }
}

export async function generateWeekly(ep: AiEndpoint, c: WeekContext) {
  const out = await chat(ep, weeklyMessages(weekContextText(c)), { json: true, timeoutMs: 120_000, temperature: 0.3 })
  return sanitizeWeekly(extractJson(out), new Set(c.openTasks.map((t) => t.id)))
}

/** 追问：带上同一份数据和报告，以及之前的对话；回答为纯文本 */
export async function askWeekly(
  ep: AiEndpoint,
  context: string,
  report: WeeklyReport,
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string
): Promise<string> {
  const system = `${WEEKLY_SYSTEM.split('只输出一个 JSON')[0]}
现在用户在追问你之前写的周复盘。用中文直接回答，几句话即可，不要输出 JSON。回答要引用数据；数据里没有的就说不知道。

本周数据：
${context}

你之前的复盘：
${JSON.stringify({ summary: report.summary, wins: report.wins, patterns: report.patterns, suggestions: report.suggestions.map((s) => ({ title: s.title, evidence: s.evidence })) })}`
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    // 只带最近的对话，避免越聊越长
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question }
  ]
  const out = await chat(ep, messages, { timeoutMs: 90_000, temperature: 0.4 })
  return out.trim().slice(0, 4000)
}
