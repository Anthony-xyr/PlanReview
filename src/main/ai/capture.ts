import type { CaptureDraft, Category } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage } from './client'

const WEEKDAYS = '日一二三四五六'

/** 本地日期 'YYYY-MM-DD' */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function captureMessages(text: string, categories: Category[], tags: string[], now: Date): ChatMessage[] {
  const cats = categories.filter((c) => !c.archived).map((c) => c.name)
  const system = `你是一个待办清单的速记解析器。用户会给你一句随手记下的话，你把它拆成结构化字段。
只输出一个 JSON 对象，不要任何解释。字段：
- title: 字符串。任务本身，去掉已经拆出去的日期、时长、#标签等修饰，保持用户的说法，不要改写或扩写。
- category: 字符串或 null。只能从这些大类里选一个：${JSON.stringify(cats)}。拿不准就填 null。
- tags: 字符串数组。用户写了 #xxx 的直接取出（不带 #）；也可以从已有标签里挑明显相关的：${JSON.stringify(tags.slice(0, 50))}。不要编造新标签。
- estimateMin: 整数或 null。用户明确说了要多久（如「2h」「半小时」「90分钟」）才填，单位分钟；没说就 null，不要猜。
- dueDate: 'YYYY-MM-DD' 或 null。用户说了截止（「周五前」「明天交」「10月20号ddl」）才填。
- reviewDate: 'YYYY-MM-DD' 或 null。用户说的是「某天再看 / 下周想想 / 有空再说」这类，不是截止，就填这里。
- notes: 字符串。原句里无法放进上面字段、又有用的信息；没有就空字符串。

今天是 ${localDate(now)}，星期${WEEKDAYS[now.getDay()]}。时区为用户本地时间。
「下周X」指下一个自然周的星期X；「这周X」若已过去则仍按本周计算。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: text }
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

export async function parseCapture(ep: AiEndpoint, text: string, categories: Category[], tags: string[], now = new Date(), reasoningEffort: 'low' | 'medium' | 'high' = 'medium'): Promise<CaptureDraft> {
  const out = await chat(ep, captureMessages(text, categories, tags, now), { json: true, timeoutMs: 60_000, reasoningEffort })
  return sanitizeCapture(extractJson(out), text, categories, tags)
}
