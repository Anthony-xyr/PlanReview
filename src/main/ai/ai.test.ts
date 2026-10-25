import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../db/schema'
import { Repo } from '../db/repo'
import { TimeRepo } from '../db/timeRepo'
import { CourseRepo, meetingDate } from '../db/courseRepo'
import { chat, extractJson, normalizeBaseUrl } from './client'
import { captureMessages, parseCapture, reparseCapture, reparseMessages, sanitizeCapture, sanitizeReparse } from './capture'
import { HabitRepo } from '../db/habitRepo'
import { sanitizeSchedule, scheduleMessages } from './schedule'
import { AiConfigStore, type SecretBox } from './config'

let db: DatabaseSync
let repo: Repo

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
})

describe('client', () => {
  it('规范化地址', () => {
    expect(normalizeBaseUrl(' https://api.deepseek.com/v1/ ')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://x.com/v1/chat/completions')).toBe('https://x.com/v1')
  })

  it('从各种输出里取 JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('好的，结果如下：{"a":{"b":2}} 希望有帮助')).toEqual({ a: { b: 2 } })
    expect(() => extractJson('没有结果')).toThrow()
  })

  it('请求格式、鉴权头、错误信息', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await chat({ baseUrl: 'https://x.com/v1', apiKey: 'sk-1', model: 'm' }, [{ role: 'user', content: 'q' }], { json: true, fetchImpl: ok })
    expect(out).toBe('hi')
    expect(calls[0].url).toBe('https://x.com/v1/chat/completions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
    expect(JSON.parse(calls[0].init.body as string).response_format).toEqual({ type: 'json_object' })

    const bad = (async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })) as unknown as typeof fetch
    await expect(chat({ baseUrl: 'https://x.com', apiKey: 'k', model: 'm' }, [], { fetchImpl: bad })).rejects.toThrow(/API Key/)
  })

  it('不支持 response_format 时自动退回', async () => {
    let n = 0
    const f = (async (_u: string, init: RequestInit) => {
      n++
      const body = JSON.parse(init.body as string)
      if (body.response_format) return new Response('{"error":{"message":"response_format not supported"}}', { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await chat({ baseUrl: 'https://x.com', apiKey: '', model: 'm' }, [], { json: true, fetchImpl: f })).toBe('{"x":1}')
    expect(n).toBe(2)
  })
})

describe('capture', () => {
  it('提示词带上今天和大类', () => {
    const msgs = captureMessages('明天交实验报告', repo.listCategories(), [], new Date(2026, 9, 15))
    expect(msgs[0].content).toContain('2026-10-15')
    expect(msgs[0].content).toContain('课程作业')
  })

  it('清洗：大类按名称匹配、标签不许编造、坏字段丢掉', () => {
    repo.updateTask(repo.capture('x').id, { tags: ['考试'] })
    const cats = repo.listCategories()
    const d = sanitizeCapture(
      { title: '看完线代第三章', category: '学习', tags: ['#数学', '考试', '瞎编的'], estimateMin: 120, dueDate: '2026-10-20', reviewDate: 'tomorrow', notes: 1 },
      '看完线代第三章 2h #数学',
      cats,
      repo.listTags()
    )
    expect(d.title).toBe('看完线代第三章')
    expect(d.categoryId).toBe(cats.find((c) => c.name === '学习')!.id)
    expect(d.tags.sort()).toEqual(['数学', '考试'])
    expect(d.estimateMin).toBe(120)
    expect(d.dueDate).toBe('2026-10-20')
    expect(d.reviewDate).toBeNull()
    expect(d.notes).toBe('')
  })

  it('完全无效的输出退回原文', () => {
    const d = sanitizeCapture(null, '  随便记一下 ', repo.listCategories(), [])
    expect(d.title).toBe('随便记一下')
    expect(d.categoryId).toBeNull()
    expect(d.estimateMin).toBeNull()
  })
})

describe('capture habits', () => {
  const draft = { title: '数电作业', categoryId: null, tags: [], estimateMin: null, dueDate: '2026-10-16', reviewDate: null, notes: '' }
  /** 假接口：记下请求，按顺序回放回复 */
  const fakeFetch = (...replies: unknown[]) => {
    const bodies: { messages: { content: string }[]; reasoning_effort?: string }[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }))
    }) as typeof fetch
    return { bodies, fetchImpl }
  }

  it('启用的习惯按编号写进提示词，没有习惯时不提', () => {
    const habits = new HabitRepo(db)
    habits.add('句首的「月.日」是布置日期，不是截止')
    const off = habits.add('不要的')
    habits.update(off.id, { enabled: false })
    const sys = captureMessages('10.16数电作业', repo.listCategories(), [], new Date(2026, 9, 24), habits.enabled())[0].content as string
    expect(sys).toContain('h1：句首的「月.日」是布置日期')
    expect(sys).not.toContain('不要的')
    expect(sys).toContain('usedHabits')
    expect(captureMessages('x', repo.listCategories(), [], new Date()).at(0)!.content).not.toContain('习惯')
  })

  it('纠正提示词带上原句、上一版（类别用名称）和全部纠正', () => {
    const cat = repo.listCategories().find((c) => c.name === '课程作业')!
    const [sys, user] = reparseMessages('10.16数电作业', { ...draft, categoryId: cat.id }, ['10.16 是布置日期', '放进备注'], repo.listCategories(), [], new Date(2026, 9, 24))
    expect(sys.content).toContain('habit')
    expect(user.content).toContain('原句：10.16数电作业')
    expect(user.content).toContain('"category":"课程作业"')
    expect(user.content).toContain('1. 10.16 是布置日期\n2. 放进备注')
  })

  it('清洗：编号换回 id，认不出的丢掉；没有习惯就不替换', () => {
    const habits = new HabitRepo(db)
    habits.add('a')
    habits.add('b')
    // 编号按传给 AI 的顺序：第 n 条是 hn
    const list = habits.enabled()
    const r = sanitizeReparse({ title: '数电作业', usedHabits: ['h2', 'H2', 'h9', 3], habit: '  句首日期  是布置日期 ', replaces: 'h1' }, '10.16数电作业', [], [], list)
    expect(r.habitIds).toEqual([list[1].id])
    expect(r.habit).toBe('句首日期 是布置日期')
    expect(r.replacesId).toBe(list[0].id)
    expect(sanitizeReparse({ habit: '', replaces: 'h1' }, 'x', [], [], list).replacesId).toBeNull()
    expect(sanitizeReparse({ habit: 'x'.repeat(500) }, 'x', [], [], list).habit).toHaveLength(120)
  })

  it('解析和重新解析：习惯编号换回 id，带上推理强度', async () => {
    const habits = new HabitRepo(db)
    habits.add('句首日期是布置日期')
    const id = habits.enabled()[0].id
    const { bodies, fetchImpl } = fakeFetch(
      { title: '数电作业', dueDate: null, notes: '10.16 布置', usedHabits: ['h1'] },
      { title: '数电作业', dueDate: null, notes: '10.16 布置', habit: '句首「月.日」是布置日期，写进备注', replaces: 'h1' }
    )
    vi.stubGlobal('fetch', fetchImpl)
    try {
      const ep = { baseUrl: 'http://x', apiKey: '', model: 'm' }
      const p = await parseCapture(ep, '10.16数电作业', [], [], new Date(2026, 9, 24), 'low', habits.enabled())
      expect(p.draft).toMatchObject({ title: '数电作业', dueDate: null, notes: '10.16 布置' })
      expect(p.habitIds).toEqual([id])
      const r = await reparseCapture(ep, '10.16数电作业', draft, ['10.16 是布置日期'], [], [], new Date(2026, 9, 24), 'high', habits.enabled())
      expect(r.habit).toBe('句首「月.日」是布置日期，写进备注')
      expect(r.replacesId).toBe(id)
      expect(bodies.map((x) => x.reasoning_effort)).toEqual(['low', 'high'])
      expect(bodies[1].messages[1].content).toContain('1. 10.16 是布置日期')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('habit repo', () => {
  it('新增、去重、替换保留使用次数、记使用', () => {
    const habits = new HabitRepo(db)
    const a = habits.add('  句首日期   是布置日期 ', '10.16数电作业')
    expect(a.text).toBe('句首日期 是布置日期')
    expect(a.example).toBe('10.16数电作业')
    expect(habits.add('句首日期 是布置日期').id).toBe(a.id)
    habits.markUsed([a.id, a.id])
    const r = habits.add('句首「月.日」是布置日期，写进备注', '10.17电路实验', a.id)
    expect(r.id).toBe(a.id)
    expect(r.usedCount).toBe(1)
    expect(r.lastUsedAt).not.toBeNull()
    expect(habits.list()).toHaveLength(1)
  })

  it('停用的不发给 AI；校验长度和上限', () => {
    const habits = new HabitRepo(db)
    const a = habits.add('a')
    habits.update(a.id, { enabled: false })
    expect(habits.enabled()).toHaveLength(0)
    // 文字相同时重新启用
    expect(habits.add('a').enabled).toBe(true)
    expect(() => habits.add('  ')).toThrow(/不能为空/)
    expect(() => habits.add('x'.repeat(121))).toThrow(/最多/)
    for (let i = 1; i < 30; i++) habits.add(`h${i}`)
    expect(() => habits.add('第 31 条')).toThrow(/最多记 30 条/)
    habits.remove(a.id)
    expect(habits.add('第 31 条').text).toBe('第 31 条')
  })
})

describe('schedule', () => {
  it('图片作为 image_url 传入，文本超长截断', () => {
    const msgs = scheduleMessages(
      [
        { name: 'a.png', kind: 'image', content: 'data:image/png;base64,AAA' },
        { name: 'b.txt', kind: 'text', content: 'x'.repeat(70_000) }
      ],
      '第一周从 9 月 1 日开始'
    )
    const parts = msgs[1].content as { type: string; text?: string }[]
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
    expect(parts.find((p) => p.text?.includes('b.txt'))!.text!.length).toBeLessThan(61_000)
    expect(parts[0].text).toContain('9 月 1 日')
  })

  it('清洗：时间补零、周次去重排序、坏记录进 notes、同名合并', () => {
    const d = sanitizeSchedule({
      termStart: '2026-09-07',
      courses: [
        { name: '线性代数', teacher: '张', location: 'A101', meetings: [{ weekday: 1, start: '8:00', end: '09:35', weeks: [3, 1, 2, 2, 99] }] },
        { name: '线性代数', meetings: [{ weekday: 3, start: '10:00', end: '11:35', weeks: [1] }] },
        { name: '大学物理', meetings: [{ weekday: 9, start: '10:00', end: '11:35', weeks: [1] }] },
        { name: '', meetings: [] }
      ],
      notes: ['第 9 周可能停课']
    })
    expect(d.termStart).toBe('2026-09-07')
    expect(d.courses).toHaveLength(1)
    const la = d.courses[0]
    expect(la.meetings).toHaveLength(2)
    expect(la.meetings[0]).toEqual({ weekday: 1, start: '08:00', end: '09:35', weeks: [1, 2, 3], location: 'A101' })
    expect(d.notes).toContain('第 9 周可能停课')
    expect(d.notes.some((n) => n.includes('大学物理'))).toBe(true)
  })

  it('没写周次时默认 1–16 周', () => {
    const d = sanitizeSchedule({ courses: [{ name: '体育', meetings: [{ weekday: 5, start: '14:00', end: '15:35' }] }] })
    expect(d.courses[0].meetings[0].weeks).toHaveLength(16)
    expect(d.termStart).toBe('')
  })
})

describe('courses', () => {
  it('周次换算日期：termStart 不是周一时也从那一周的周一算', () => {
    expect(meetingDate('2026-09-07', 1, 1)).toEqual(new Date(2026, 8, 7))
    expect(meetingDate('2026-09-09', 1, 1)).toEqual(new Date(2026, 8, 7))
    expect(meetingDate('2026-09-07', 3, 5)).toEqual(new Date(2026, 8, 25))
  })

  it('导入生成计划时段，替换时先删旧课表', () => {
    const courses = new CourseRepo(db)
    const time = new TimeRepo(db)
    const draft = {
      termStart: '2026-09-07',
      notes: [],
      courses: [{ name: '线代', teacher: '', location: 'A101', meetings: [{ weekday: 1, start: '08:00', end: '09:35', weeks: [1, 2], location: 'A101' }] }]
    }
    expect(courses.commit(draft, false)).toEqual({ courses: 1, blocks: 2 })
    const blocks = time.listBlocks(new Date(2026, 8, 1).toISOString(), new Date(2026, 9, 1).toISOString())
    expect(blocks.map((b) => [b.title, b.location, new Date(b.startAt).getHours()])).toEqual([
      ['线代', 'A101', 8],
      ['线代', 'A101', 8]
    ])
    expect(blocks[0].courseId).toBeTruthy()
    expect(repo.listCategories().some((c) => c.name === '课程')).toBe(true)

    expect(courses.commit(draft, true).blocks).toBe(2)
    expect(courses.list()).toHaveLength(1)
    expect(courses.removeAll()).toEqual({ courses: 1, blocks: 2 })
    expect(time.listBlocks(new Date(2026, 8, 1).toISOString(), new Date(2026, 9, 1).toISOString())).toHaveLength(0)
  })

  it('校验', () => {
    const courses = new CourseRepo(db)
    expect(() => courses.commit({ termStart: '', courses: [], notes: [] }, false)).toThrow(/第一周/)
    expect(() =>
      courses.commit({ termStart: '2026-09-07', notes: [], courses: [{ name: 'x', teacher: '', location: '', meetings: [{ weekday: 1, start: '10:00', end: '09:00', weeks: [1], location: '' }] }] }, false)
    ).toThrow()
  })
})

describe('config', () => {
  const box: SecretBox = { available: () => true, encrypt: (s) => `enc(${s})`, decrypt: (s) => s.slice(4, -1) }

  it('Key 加密保存，界面看不到明文', () => {
    const store = new AiConfigStore(db, box)
    const v = store.update({ enabled: true, baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKey: ' sk-secret ' })
    expect(v).not.toHaveProperty('apiKey')
    expect(v.hasKey).toBe(true)
    expect(v.keyEncrypted).toBe(true)
    expect(v.baseUrl).toBe('https://api.deepseek.com')
    const raw = (db.prepare("SELECT value FROM settings WHERE key = 'ai.config'").get() as { value: string }).value
    expect(raw).not.toContain('"sk-secret"')
    expect(store.endpoint().apiKey).toBe('sk-secret')
    // 不传 apiKey 不会清掉
    store.update({ model: 'x' })
    expect(store.view().hasKey).toBe(true)
    store.update({ apiKey: '' })
    expect(store.view().hasKey).toBe(false)
  })

  it('识图模型、开关、地址校验', () => {
    const store = new AiConfigStore(db, box)
    expect(() => store.endpoint()).toThrow(/没有开启/)
    store.update({ enabled: true, baseUrl: 'https://x.com', model: 'a', visionModel: 'b' })
    expect(store.endpoint(true).model).toBe('b')
    expect(store.endpoint(false).model).toBe('a')
    expect(store.captureEnabled()).toBe(true)
    expect(() => store.update({ baseUrl: 'ftp://x' })).toThrow()
  })
})
