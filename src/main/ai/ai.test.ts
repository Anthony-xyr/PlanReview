import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { Repo } from '../db/repo'
import { TimeRepo } from '../db/timeRepo'
import { CourseRepo, meetingDate } from '../db/courseRepo'
import { chat, extractJson, normalizeBaseUrl } from './client'
import { captureMessages, sanitizeCapture } from './capture'
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
