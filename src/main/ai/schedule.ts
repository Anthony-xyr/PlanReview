import type { CourseMeeting, ImportFile, ScheduleDraft } from '@shared/types'
import { chat, extractJson, type AiEndpoint, type ChatMessage, type ContentPart } from './client'

/** 单个文件给模型的文本上限，防止一份大表格把上下文撑爆 */
const MAX_TEXT_CHARS = 60_000

export const SCHEDULE_SYSTEM = `你是课程表解析器。用户会上传若干文件：课程表（截图、PDF 文字或表格），通常还有学校的作息时间表（第几节课几点开始、几点结束）。
你的任务：把课程表里的「第几节到第几节」用作息时间表换算成具体的开始、结束时间，输出结构化课表。

只输出一个 JSON 对象，不要任何解释，格式如下：
{
  "termStart": "YYYY-MM-DD 或空字符串",
  "courses": [
    {
      "name": "课程名",
      "teacher": "教师，没有就空字符串",
      "location": "常用地点，没有就空字符串",
      "meetings": [
        { "weekday": 1, "start": "08:00", "end": "09:35", "weeks": [1,2,3], "location": "这次课的地点" }
      ]
    }
  ],
  "notes": ["解析中不确定、需要用户核对的地方"]
}

规则：
- weekday：1=周一 … 7=周日。
- start / end：24 小时制 'HH:MM'。第 m 节到第 n 节，开始时间取第 m 节的开始，结束时间取第 n 节的结束。
- weeks：上课的周次列表，要展开成具体数字。例：「1-16周」→ 1 到 16；「1-15周(单)」→ 1,3,5,…,15；「2-16双周」→ 2,4,…,16；「1-8,10-16周」→ 跳过第 9 周。课表上完全没写周次时，按 1-16 周处理，并在 notes 里说明。
- 同一门课在不同时间上课，就放多个 meetings；同一门课不要拆成多个 course。
- termStart：用户告诉了你、或者文件里写了「第一周从 X 月 X 日开始」才填第一周的周一，否则填空字符串。
- 看不清、对不上、作息表缺失导致换算不了的，写进 notes，不要编造。缺作息表时可以按常见作息估计，但一定要在 notes 里明确说明是估计的。
- 只输出 JSON。`

export function scheduleMessages(files: ImportFile[], hint: string): ChatMessage[] {
  const parts: ContentPart[] = []
  const intro = hint.trim() ? `补充说明：${hint.trim()}\n\n` : ''
  parts.push({ type: 'text', text: `${intro}下面是我上传的 ${files.length} 个文件。` })
  for (const f of files) {
    if (f.kind === 'image') {
      parts.push({ type: 'text', text: `【文件：${f.name}（图片）】` })
      parts.push({ type: 'image_url', image_url: { url: f.content } })
    } else {
      const text = f.content.length > MAX_TEXT_CHARS ? `${f.content.slice(0, MAX_TEXT_CHARS)}\n…（内容过长已截断）` : f.content
      parts.push({ type: 'text', text: `【文件：${f.name}】\n${text}` })
    }
  }
  return [
    { role: 'system', content: SCHEDULE_SYSTEM },
    { role: 'user', content: parts }
  ]
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/

function clock(v: unknown): string | null {
  const m = typeof v === 'string' ? v.trim().replace('：', ':').match(CLOCK) : null
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

/** 校验并清洗 AI 输出；不合规的上课记录丢掉并写进 notes */
export function sanitizeSchedule(raw: unknown): ScheduleDraft {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const notes: string[] = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim()) : []
  const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

  const courses: ScheduleDraft['courses'] = []
  for (const c of Array.isArray(o.courses) ? o.courses : []) {
    const co = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const name = str(co.name)
    if (!name) continue
    const meetings: CourseMeeting[] = []
    for (const m of Array.isArray(co.meetings) ? co.meetings : []) {
      const mo = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      const weekday = Number(mo.weekday)
      const start = clock(mo.start)
      const end = clock(mo.end)
      const weeks = [...new Set((Array.isArray(mo.weeks) ? mo.weeks : []).map(Number).filter((w) => Number.isInteger(w) && w >= 1 && w <= 30))].sort((a, b) => a - b)
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !start || !end || start >= end) {
        notes.push(`「${name}」有一次上课的时间不完整，已跳过，请手动补上`)
        continue
      }
      meetings.push({ weekday, start, end, weeks: weeks.length ? weeks : Array.from({ length: 16 }, (_, i) => i + 1), location: str(mo.location) || str(co.location) })
    }
    if (!meetings.length) continue
    // 同名课程合并
    const existing = courses.find((x) => x.name === name)
    if (existing) existing.meetings.push(...meetings)
    else courses.push({ name, teacher: str(co.teacher, 50), location: str(co.location), meetings })
  }

  const ts = str(o.termStart)
  return { termStart: /^\d{4}-\d{2}-\d{2}$/.test(ts) ? ts : '', courses, notes }
}

export async function parseSchedule(ep: AiEndpoint, files: ImportFile[], hint: string, reasoningEffort: 'low' | 'medium' | 'high' = 'medium'): Promise<ScheduleDraft> {
  if (!files.length) throw new Error('请先选择文件')
  const out = await chat(ep, scheduleMessages(files, hint), { json: !files.some((f) => f.kind === 'image'), timeoutMs: 180_000, reasoningEffort })
  return sanitizeSchedule(extractJson(out))
}
