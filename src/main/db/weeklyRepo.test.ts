import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { Repo } from './repo'
import { TimeRepo } from './timeRepo'
import { ReviewRepo } from './reviewRepo'
import { WeeklyRepo, mondayOf } from './weeklyRepo'
import type { WeeklyReport } from '@shared/types'

let db: DatabaseSync
let repo: Repo
let time: TimeRepo
let weekly: WeeklyRepo
let clock: Date

// 2026-10-12 是周一
const WEEK = '2026-10-12'
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m)
const iso = (d: number, h: number, m = 0) => local(d, h, m).toISOString()

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  clock = local(18, 22) // 周日晚上
  repo = new Repo(db, () => clock)
  time = new TimeRepo(db, () => clock)
  weekly = new WeeklyRepo(db, repo, time, () => clock)
})

const report = (over: Partial<WeeklyReport> = {}): WeeklyReport => ({
  summary: '这周学习时间稳定',
  wins: ['每天都有记录'],
  patterns: ['晚上效率低'],
  suggestions: [
    { id: 's1', title: '默认本次改成 40 分钟', evidence: '7 次里 5 次在 40 分钟左右停下', action: { kind: 'setting', key: 'defaultSessionMin', value: 40 }, status: 'open' },
    { id: 's2', title: '记住这个规律', evidence: '周二周四都熬到 1 点', action: { kind: 'insight', text: '周二周四容易熬夜' }, status: 'open' }
  ],
  ...over
})

describe('helpers', () => {
  it('mondayOf', () => {
    expect(mondayOf('2026-10-18')).toBe(WEEK) // 周日
    expect(mondayOf('2026-10-12')).toBe(WEEK)
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
  })

  it('周起点必须是周一', () => {
    expect(() => weekly.stats('2026-10-13')).toThrow()
  })
})

describe('stats', () => {
  it('每天按大类的实际、计划兑现率、睡眠窗口里的活动', () => {
    const [study, , , , fun] = repo.listCategories()
    const t = repo.createTask({ title: '线代', status: 'active', categoryId: study.id })
    // 周一：计划 2h，做了 1h（兑现 50%）
    time.createBlock({ taskId: t.id, startAt: iso(12, 9), endAt: iso(12, 11) })
    time.createEntry({ taskId: t.id, startAt: iso(12, 9), endAt: iso(12, 10) })
    // 周二晚上打游戏到 1:30（睡眠窗口 00:30 开始）—— 仍算周二（一天从 5 点算）
    time.createEntry({ title: '打游戏', categoryId: fun.id, startAt: iso(13, 23), endAt: iso(14, 1, 30) })
    // 下周的计划不算
    time.createBlock({ taskId: t.id, startAt: iso(20, 9), endAt: iso(20, 10) })

    const s = weekly.stats(WEEK)
    expect(s.days).toHaveLength(7)
    expect(s.days[0]).toMatchObject({ day: WEEK, plannedMin: 120, actualMin: 60, byCategory: { [study.id]: 60 } })
    expect(s.days[1]).toMatchObject({ actualMin: 150, sleepWindowMin: 60, byCategory: { [fun.id]: 150 } })
    expect(s.days[1].lastEndAt).toBe(iso(14, 1, 30))
    expect(s.fulfilment).toBeCloseTo(0.5)
    expect(s.plannedMin).toBe(120)
    expect(s.actualMin).toBe(210)
    expect(s.byCategory.map((c) => [c.categoryId, c.actualMin])).toEqual([
      [fun.id, 150],
      [study.id, 60]
    ])
  })

  it('估时偏差、超时原因、完成 / 新建 / 延伸计数', () => {
    const t = repo.createTask({ title: '实验报告', status: 'active', estimateMin: 60 })
    clock = local(14, 10)
    time.start({ taskId: t.id, durationMin: 30 })
    clock = local(14, 11, 30) // 做了 90 分钟，原定 30
    time.stop({ overrunReason: 'scope', complete: true })
    repo.spinOff(t.id, { title: '补数据' })
    clock = local(18, 22)

    const s = weekly.stats(WEEK)
    expect(s.estimates).toEqual([{ taskId: t.id, title: '实验报告', categoryId: null, estimateMin: 60, spentMin: 90 }])
    expect(s.reasons).toEqual([{ reason: 'scope', count: 1, minutes: 60 }])
    expect(s.completed).toBe(1)
    expect(s.created).toBe(2)
    expect(s.spinOffs).toBe(1)
  })

  it('补录的记录和对应计划块比，超时也算进原因统计', () => {
    const t = repo.createTask({ title: '实验报告', status: 'active' })
    time.createBlock({ taskId: t.id, startAt: iso(14, 19), endAt: iso(14, 20) })
    time.createEntry({ taskId: t.id, startAt: iso(14, 19), endAt: iso(14, 20, 30) })
    expect(weekly.stats(WEEK).reasons).toEqual([{ reason: 'none', count: 1, minutes: 30 }])
  })

  it('上课时段不算进计划和兑现率；复盘过的天数与心情', () => {
    db.prepare(`INSERT INTO courses (id, name, meetings, term_start, updated_at) VALUES ('c1', '高数', '[]', '2026-09-07', '')`).run()
    const b = time.createBlock({ title: '高数', startAt: iso(12, 8), endAt: iso(12, 9) })
    db.prepare(`UPDATE plan_blocks SET course_id = 'c1' WHERE id = ?`).run(b.id)
    new ReviewRepo(db, repo, time, () => clock).save(WEEK, { mood: 4 })
    const s = weekly.stats(WEEK)
    expect(s.plannedMin).toBe(0)
    expect(s.fulfilment).toBeNull()
    expect(s.reviewedDays).toBe(1)
    expect(s.days[0].mood).toBe(4)
  })
})

describe('report & suggestions', () => {
  it('保存报告会清掉旧对话；画像候选去重', () => {
    weekly.saveReport(WEEK, report(), 'm', [{ text: '晚上效率低', evidence: 'x' }])
    weekly.addMessage(WEEK, 'user', '为什么？')
    expect(weekly.get(WEEK)!.messages).toHaveLength(1)
    weekly.saveReport(WEEK, report(), 'm', [{ text: '晚上效率低', evidence: 'x' }])
    expect(weekly.get(WEEK)!.messages).toHaveLength(0)
    expect(weekly.listInsights().map((i) => [i.text, i.status])).toEqual([['晚上效率低', 'pending']])
  })

  it('采纳设置类建议会改设置；画像类会写成已确认；处理过的不能再处理', () => {
    weekly.saveReport(WEEK, report(), 'm', [])
    weekly.apply(WEEK, 's1')
    expect(time.getSettings().defaultSessionMin).toBe(40)
    expect(() => weekly.apply(WEEK, 's1')).toThrow(/处理过/)
    weekly.apply(WEEK, 's2')
    expect(weekly.acceptedInsights()).toEqual(['周二周四容易熬夜'])
    expect(weekly.get(WEEK)!.report!.suggestions.map((s) => s.status)).toEqual(['applied', 'applied'])
  })

  it('改动校验失败时不标记为已采纳', () => {
    weekly.saveReport(WEEK, report({ suggestions: [{ id: 'x', title: 't', evidence: 'e', action: { kind: 'setting', key: 'extendStepMin', value: 999 }, status: 'open' }] }), 'm', [])
    expect(() => weekly.apply(WEEK, 'x')).toThrow()
    expect(weekly.get(WEEK)!.report!.suggestions[0].status).toBe('open')
    weekly.dismiss(WEEK, 'x')
    expect(weekly.get(WEEK)!.report!.suggestions[0].status).toBe('dismissed')
  })

  it('估时建议改任务估时', () => {
    const t = repo.createTask({ title: '大作业', status: 'active', estimateMin: 120 })
    weekly.saveReport(WEEK, report({ suggestions: [{ id: 'e', title: 't', evidence: 'e', action: { kind: 'estimate', taskId: t.id, estimateMin: 200 }, status: 'open' }] }), 'm', [])
    weekly.apply(WEEK, 'e')
    expect(repo.getTask(t.id)!.estimateMin).toBe(200)
  })

  it('画像：确认、改写、删除', () => {
    weekly.saveReport(WEEK, report(), 'm', [{ text: '编程任务估时偏低', evidence: '3 次都超 40%' }])
    const [i] = weekly.listInsights()
    expect(weekly.acceptedInsights()).toEqual([])
    weekly.updateInsight(i.id, { status: 'accepted', text: '编程类任务估时常偏低 40%' })
    expect(weekly.acceptedInsights()).toEqual(['编程类任务估时常偏低 40%'])
    // 重新生成不会删掉已确认的
    weekly.saveReport(WEEK, report(), 'm', [])
    expect(weekly.acceptedInsights()).toHaveLength(1)
    weekly.removeInsight(i.id)
    expect(weekly.listInsights()).toEqual([])
  })
})
