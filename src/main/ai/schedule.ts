import type { CourseMeeting, ImportFile, ScheduleDraft } from '@shared/types'
import { calendarDateKey, calendarMonday, localCalendarKey, parseCalendarDate } from '@shared/calendarDate'
import { chat, extractJson, type AiEndpoint, type ChatMessage, type ContentPart } from './client'

/** 单个文件给模型的文本上限，防止一份大表格把上下文撑爆 */
const MAX_TEXT_CHARS = 60_000

const WEEKDAYS = '日一二三四五六'

const FIRST_WEEK = String.raw`第\s*[1一]\s*周`
const SPECIFIED_DATE = String.raw`(?:(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:\s*[日号])?|(\d{1,2})\s*月\s*(\d{1,2})\s*[日号])(?!\d)`

function weekNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  const digit = (c: string) => c === '两' ? 2 : '零一二三四五六七八九'.indexOf(c)
  if (text.length === 1 && text !== '十') return digit(text)
  const parts = text.split('十')
  if (parts.length !== 2 || parts.some((part) => part.length > 1)) return NaN
  const [tens, ones] = parts
  return 10 * (tens ? digit(tens) : 1) + (ones ? digit(ones) : 0)
}

export function inferTermStart(hint: string, now: Date): { termStart: string; notes: string[] } | null {
  const text = hint.normalize('NFKC')
  const today = parseCalendarDate(localCalendarKey(now))!
  const weeks = new Set<number>()
  for (const match of text.matchAll(/(?:今天|本周|这周|目前|现在|当前)\s*(?:是|为|处于|已到|到了)?\s*第\s*(\d+|[一二三四五六七八九十两零]+)\s*周/g)) {
    if (/^\s*(?:吗|么|还是|或[者是]|\?)/.test(text.slice(match.index! + match[0].length))) continue
    const week = weekNumber(match[1])
    if (!Number.isInteger(week) || week < 1 || week > 30) throw new Error('补充说明里的当前周次须在第 1–30 周之间')
    weeks.add(week)
  }
  const [week] = weeks
  const fromWeek = weeks.size === 1 ? calendarMonday(today, week - 1) : ''

  const explicit = new Map<string, string>()
  const patterns = [
    new RegExp(String.raw`(?:${FIRST_WEEK}(?:\s*(?:的)?\s*(?:周一|星期一|开始日期|起始日|日期))?|开学(?:日期|时间)?|学期(?:起始|开始)(?:日期|时间)?)\s*(?:从|是|为|在)?\s*[:=]?\s*${SPECIFIED_DATE}`, 'g'),
    new RegExp(String.raw`${SPECIFIED_DATE}\s*(?:是|为)\s*${FIRST_WEEK}`, 'g')
  ]
  for (const pattern of patterns) {
    for (const [, year, fullMonth, fullDay, shortMonth, shortDay] of text.matchAll(pattern)) {
      const month = Number(fullMonth ?? shortMonth)
      const day = Number(fullDay ?? shortDay)
      // 没写年份时，优先用已算出的第一周作参照，否则取最接近今天的年份。
      const reference = fromWeek ? parseCalendarDate(fromWeek)! : today
      const base = reference.getUTCFullYear()
      const selectedYear = year ? Number(year) : [base, base - 1, base + 1].reduce((nearest, candidate) => {
        const distance = (y: number) => {
          const date = new Date(0)
          date.setUTCFullYear(y, month - 1, day)
          return Math.abs(date.getTime() - reference.getTime())
        }
        return distance(candidate) < distance(nearest) ? candidate : nearest
      })
      const key = calendarDateKey(selectedYear, month, day)
      const date = parseCalendarDate(key)
      if (!date) throw new Error(`补充说明里的开学日期「${key}」不是有效的日历日期，请修改后再分析`)
      explicit.set(calendarMonday(date), year ? key : `${key}（未填写年份，按最近日期推定，请核对）`)
    }
  }
  if (explicit.size > 1) throw new Error('补充说明里有互相冲突的第一周日期，请保留一个再分析')
  if (explicit.size === 1) {
    const [[termStart, specified]] = explicit
    const notes = [`按补充说明的开学日期 ${specified}，第一周周一为 ${termStart}。`]
    if ((fromWeek && fromWeek !== termStart) || weeks.size > 1) {
      notes.push('补充说明中的当前周次与开学日期不一致，采用明确填写的开学日期。')
    }
    return { termStart, notes }
  }
  if (weeks.size > 1) throw new Error('补充说明里有互相冲突的当前周次，请保留一个再分析')
  return fromWeek ? { termStart: fromWeek, notes: [`按补充说明的当前第 ${week} 周和本地日期 ${localCalendarKey(now)}，倒推第一周周一为 ${fromWeek}。`] } : null
}

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
- termStart：学期第一周周一的日期（YYYY-MM-DD）。
  - 用户或文件写明了第一周从哪天开始，填那一天所在周的周一；
  - 用户说明了当前是第几周（例如「今天是第11周」），请结合用户发消息时的今天日期倒推算出第 1 周周一；
  - 否则填空字符串。
- 看不清、对不上、作息表缺失导致换算不了的，写进 notes，不要编造。缺作息表时可以按常见作息估计，但一定要在 notes 里明确说明是估计的。
- 只输出 JSON。`

export function scheduleMessages(files: ImportFile[], hint: string, now = new Date()): ChatMessage[] {
  const parts: ContentPart[] = []
  const todayStr = `今天是 ${localCalendarKey(now)}，星期${WEEKDAYS[now.getDay()]}。时区为用户本地时间。`
  const intro = hint.trim() ? `补充说明：${hint.trim()}\n\n` : ''
  parts.push({ type: 'text', text: `${todayStr}\n${intro}下面是我上传的 ${files.length} 个文件。` })
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
  const ts = typeof o.termStart === 'string' ? o.termStart.trim() : o.termStart
  const date = parseCalendarDate(ts)
  if (ts != null && ts !== '' && !date) throw new Error('AI 返回的第一周日期不是有效的日历日期（应为 YYYY-MM-DD），请补充正确日期后重新分析')
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

  const termStart = date ? calendarMonday(date) : ''
  if (date && termStart !== ts) notes.push(`AI 返回的 ${ts} 不在周一，按其所在周调整为 ${termStart}。`)
  return { termStart, courses, notes }
}

export function preferHintTermStart(draft: ScheduleDraft, inferred: ReturnType<typeof inferTermStart>): ScheduleDraft {
  if (!inferred) return draft
  const notes = [...inferred.notes]
  if (draft.termStart && draft.termStart !== inferred.termStart) {
    notes.push(`AI 给出的第一周周一为 ${draft.termStart}，与补充说明不一致，采用本地计算的 ${inferred.termStart}。`)
  }
  return { ...draft, termStart: inferred.termStart, notes: [...notes, ...draft.notes] }
}

export async function parseSchedule(
  ep: AiEndpoint,
  files: ImportFile[],
  hint: string,
  reasoningEffort: 'low' | 'medium' | 'high' = 'medium',
  now = new Date()
): Promise<ScheduleDraft> {
  if (!files.length) throw new Error('请先选择文件')
  const inferred = inferTermStart(hint, now)
  const out = await chat(ep, scheduleMessages(files, hint, now), { json: !files.some((f) => f.kind === 'image'), timeoutMs: 180_000, reasoningEffort })
  return preferHintTermStart(sanitizeSchedule(extractJson(out)), inferred)
}
