import type { CaptureDraft, CaptureHabit, CaptureParse, CaptureReparse, Category, ReasoningEffort } from '@shared/types'
import { MAX_HABIT_CHARS } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage } from './client'

const WEEKDAYS = '日一二三四五六'

/** 本地日期 'YYYY-MM-DD' */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 给模型看的习惯编号：h1、h2…，比 UUID 短，也不会被抄错 */
const habitKey = (i: number) => `h${i + 1}`

function fieldRules(categories: Category[], tags: string[]): string {
  const cats = categories.filter((c) => !c.archived).map((c) => c.name)
  return `- title: 字符串。任务本身，去掉已经拆出去的日期、时长、#标签等修饰，保持用户的说法，不要改写或扩写。
- category: 字符串或 null。只能从这些类别里选一个：${JSON.stringify(cats)}。拿不准就填 null。
- tags: 字符串数组。用户写了 #xxx 的直接取出（不带 #）；也可以从已有标签里挑明显相关的：${JSON.stringify(tags.slice(0, 50))}。不要编造新标签。
- estimateMin: 整数或 null。用户明确说了要多久（如「2h」「半小时」「90分钟」）才填，单位分钟；没说就 null，不要猜。
- dueDate: 'YYYY-MM-DD' 或 null。用户说了截止（「周五前」「明天交」「10月20号ddl」）才填。
- reviewDate: 'YYYY-MM-DD' 或 null。用户说的是「某天再看 / 下周想想 / 有空再说」这类，不是截止，就填这里。
- notes: 字符串。原句里无法放进上面字段、又有用的信息；没有就空字符串。`
}

function habitsBlock(habits: CaptureHabit[]): string {
  if (!habits.length) return ''
  return `

这个用户的习惯（用户亲自确认过，和上面的通用规则冲突时以习惯为准）：
${habits.map((h, i) => `${habitKey(i)}：${h.text}`).join('\n')}
- usedHabits: 字符串数组。这次实际影响了解析结果的习惯编号，如 ["h1"]；没用到就 []。`
}

function dateContext(now: Date): string {
  return `今天是 ${localDate(now)}，星期${WEEKDAYS[now.getDay()]}。时区为用户本地时间。
「下周X」指下一个自然周的星期X；「这周X」若已过去则仍按本周计算。`
}

export function captureMessages(text: string, categories: Category[], tags: string[], now: Date, habits: CaptureHabit[] = []): ChatMessage[] {
  const system = `你是一个待办清单的速记解析器。用户会给你一句随手记下的话，你把它拆成结构化字段。
只输出一个 JSON 对象，不要任何解释。字段：
${fieldRules(categories, tags)}${habitsBlock(habits)}

${dateContext(now)}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: text }
  ]
}

/** 发给模型的上一版结果：用类别名而不是 id */
function draftForModel(d: CaptureDraft, categories: Category[]) {
  return {
    title: d.title,
    category: categories.find((c) => c.id === d.categoryId)?.name ?? null,
    tags: d.tags,
    estimateMin: d.estimateMin,
    dueDate: d.dueDate,
    reviewDate: d.reviewDate,
    notes: d.notes
  }
}

/**
 * 纠正后重新解析：带上原句、上一版结果（含用户手动改过的）、用户历次的纠正说明，
 * 一次拿回新结果和一条可以记住的习惯。
 */
export function reparseMessages(
  text: string,
  previous: CaptureDraft,
  feedback: string[],
  categories: Category[],
  tags: string[],
  now: Date,
  habits: CaptureHabit[] = []
): ChatMessage[] {
  const system = `你是一个待办清单的速记解析器。你之前解析过用户的一句速记，用户指出了哪里和 TA 的意思不符。
请按用户的纠正重新解析，并把这次纠正概括成一条以后也适用的习惯。
只输出一个 JSON 对象，不要任何解释。字段：
${fieldRules(categories, tags)}${habitsBlock(habits)}
- habit: 字符串。把纠正概括成一条通用规则，写清「什么样的写法 → 怎么理解」，以后遇到类似的速记也能照做，不要只针对这一句；不超过 60 个字。纠正只针对这一句、不能推广（比如只是标题打错字），就填空字符串。
- replaces: 字符串或 null。新习惯和上面某条习惯说的是同一件事、或者互相矛盾，填那条的编号（如 "h2"），保存后会替换它；否则 null。

${dateContext(now)}`

  const user = [
    `原句：${text}`,
    `你上次的解析（用户可能已经手动改过其中的字段）：${JSON.stringify(draftForModel(previous, categories))}`,
    `用户的纠正：\n${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
  ].join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** 校验并清洗 AI 输出；任何不合规的字段都丢掉，绝不信任 */
export function sanitizeCapture(raw: unknown, original: string, categories: Category[], tags: string[]): CaptureDraft {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const date = (v: unknown) => {
    const s = str(v)
    return DATE.test(s) && !Number.isNaN(new Date(`${s}T12:00`).getTime()) ? s : null
  }

  const catName = str(o.category)
  const cat = categories.find((c) => !c.archived && c.name === catName)
  const est = typeof o.estimateMin === 'number' ? Math.round(o.estimateMin) : Number.NaN
  const rawTags = Array.isArray(o.tags) ? o.tags : []
  // 只保留原句里写了 #的，或已存在的标签
  const explicit = new Set([...original.matchAll(/#([^\s#]+)/g)].map((m) => m[1]))
  const known = new Set(tags)
  const cleanTags = [...new Set(rawTags.map((t) => str(t).replace(/^#/, '')).filter((t) => t && t.length <= 30 && (explicit.has(t) || known.has(t))))]

  return {
    title: str(o.title).slice(0, 200) || original.trim(),
    categoryId: cat?.id ?? null,
    tags: cleanTags,
    estimateMin: Number.isFinite(est) && est > 0 && est <= 100 * 60 ? est : null,
    dueDate: date(o.dueDate),
    reviewDate: date(o.reviewDate),
    notes: str(o.notes).slice(0, 2000)
  }
}

/** 把模型给的习惯编号换回 id；编号不认识的丢掉 */
function habitId(key: unknown, habits: CaptureHabit[]): string | null {
  const m = typeof key === 'string' ? key.trim().match(/^h(\d+)$/i) : null
  const h = m ? habits[Number(m[1]) - 1] : undefined
  return h?.id ?? null
}

export function sanitizeUsed(raw: unknown, habits: CaptureHabit[]): string[] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(o.usedHabits) ? o.usedHabits : []
  return [...new Set(list.map((k) => habitId(k, habits)).filter((id): id is string => !!id))]
}

export function sanitizeReparse(raw: unknown, original: string, categories: Category[], tags: string[], habits: CaptureHabit[]): CaptureReparse {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const habit = typeof o.habit === 'string' ? o.habit.trim().replace(/\s+/g, ' ').slice(0, MAX_HABIT_CHARS) : ''
  return {
    draft: sanitizeCapture(raw, original, categories, tags),
    habitIds: sanitizeUsed(raw, habits),
    habit,
    replacesId: habit ? habitId(o.replaces, habits) : null
  }
}

export async function parseCapture(
  ep: AiEndpoint,
  text: string,
  categories: Category[],
  tags: string[],
  now = new Date(),
  reasoningEffort: ReasoningEffort = 'medium',
  habits: CaptureHabit[] = []
): Promise<CaptureParse> {
  const out = await chat(ep, captureMessages(text, categories, tags, now, habits), { json: true, timeoutMs: 60_000, reasoningEffort })
  const raw = extractJson(out)
  return { draft: sanitizeCapture(raw, text, categories, tags), habitIds: sanitizeUsed(raw, habits) }
}

export async function reparseCapture(
  ep: AiEndpoint,
  text: string,
  previous: CaptureDraft,
  feedback: string[],
  categories: Category[],
  tags: string[],
  now = new Date(),
  reasoningEffort: ReasoningEffort = 'medium',
  habits: CaptureHabit[] = []
): Promise<CaptureReparse> {
  const msgs = reparseMessages(text, previous, feedback, categories, tags, now, habits)
  const out = await chat(ep, msgs, { json: true, timeoutMs: 60_000, reasoningEffort })
  return sanitizeReparse(extractJson(out), text, categories, tags, habits)
}
