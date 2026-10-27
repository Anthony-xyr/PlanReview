import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { Repo } from './repo'
import { TimeRepo } from './timeRepo'
import { ReviewRepo, daysBetween, weightedPick } from './reviewRepo'

let db: DatabaseSync
let repo: Repo
let time: TimeRepo
let review: ReviewRepo
let clock: Date
let seq: number

// 本地时间，避免时区影响「哪一天」
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m)
const iso = (d: number, h: number, m = 0) => local(d, h, m).toISOString()
const DAY = '2026-10-15' // 周四

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
  clock = local(15, 20)
  time = new TimeRepo(db, () => clock)
  // 可预测的「随机」：依次 0, 0.5, 0.99 …
  seq = 0
  const rng = () => [0, 0.5, 0.99][seq++ % 3]
  review = new ReviewRepo(db, repo, time, () => clock, rng)
})

describe('helpers', () => {
  it('daysBetween 跨月', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3)
    expect(daysBetween('2026-10-15', '2026-10-15')).toBe(0)
  })

  it('weightedPick 不放回、跳过权重 0', () => {
    const items = [
      { item: 'a', weight: 1 },
      { item: 'b', weight: 0 },
      { item: 'c', weight: 3 }
    ]
    const out = weightedPick(items, 5, () => 0.9)
    expect(out.sort()).toEqual(['a', 'c'])
    // r = 0 时总是落在第一个
    expect(weightedPick(items, 1, () => 0)).toEqual(['a'])
  })
})

describe('resurface', () => {
  it('到了下次查看日（含已过）的任务出现在 due，按日期排序', () => {
    const a = repo.createTask({ title: '想想换专业', status: 'active', reviewDate: '2026-10-15' })
    const b = repo.createTask({ title: '旧想法', status: 'inbox', reviewDate: '2026-10-01' })
    repo.createTask({ title: '还没到', status: 'active', reviewDate: '2026-10-20' })
    repo.createTask({ title: '已完成的', status: 'done', reviewDate: '2026-10-10' })
    expect(review.get(DAY).due.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it('处理方式：移到待办 / 过几天再看 / 不再提醒 / 不做了', () => {
    const t = repo.createTask({ title: 'x', status: 'inbox', reviewDate: DAY })
    expect(review.act(t.id, { kind: 'keep' })).toMatchObject({ status: 'active', reviewDate: null })
    repo.updateTask(t.id, { reviewDate: DAY })
    expect(review.act(t.id, { kind: 'later', days: 7 }).reviewDate).toBe('2026-10-22')
    expect(review.act(t.id, { kind: 'clear' }).reviewDate).toBeNull()
    expect(review.act(t.id, { kind: 'drop' }).status).toBe('dropped')
    expect(() => review.act(t.id, { kind: 'later', days: 0 })).toThrow()
  })

  it('随机推送：只抽没截止、没排期、没设查看日的；同一天内不变', () => {
    time.updateSettings({ dailyPicks: 3 })
    const ok1 = repo.createTask({ title: '学吉他', status: 'active' })
    const ok2 = repo.capture('读三体')
    repo.createTask({ title: '有截止', status: 'active', dueDate: '2026-10-20' })
    repo.createTask({ title: '有查看日', status: 'active', reviewDate: '2026-11-01' })
    const planned = repo.createTask({ title: '排了明天', status: 'active' })
    time.createBlock({ taskId: planned.id, startAt: iso(16, 14), endAt: iso(16, 15) })

    const first = review.get(DAY).picks.map((t) => t.id)
    expect(first.sort()).toEqual([ok1.id, ok2.id].sort())
    expect(review.get(DAY).picks.map((t) => t.id).sort()).toEqual(first.sort())
  })

  it('推送处理后当天不再出现；dailyPicks=0 关闭', () => {
    time.updateSettings({ dailyPicks: 1 })
    const t = repo.createTask({ title: '学吉他', status: 'active' })
    expect(review.get(DAY).picks.map((x) => x.id)).toEqual([t.id])
    review.act(t.id, { kind: 'later', days: 30 })
    expect(review.get(DAY).picks).toEqual([])

    time.updateSettings({ dailyPicks: 0 })
    repo.createTask({ title: '另一个', status: 'active' })
    expect(review.get('2026-10-16').picks).toEqual([])
  })

  it('推送后排进了计划，当天就不再出现；计划删掉后回来', () => {
    time.updateSettings({ dailyPicks: 1 })
    const t = repo.createTask({ title: '学吉他', status: 'active' })
    expect(review.get(DAY).picks.map((x) => x.id)).toEqual([t.id])
    const block = time.createBlock({ taskId: t.id, startAt: iso(15, 21), endAt: iso(15, 22) })
    expect(review.get(DAY).picks).toEqual([])
    time.deleteBlock(block.id)
    expect(review.get(DAY).picks.map((x) => x.id)).toEqual([t.id])
  })

  it('推送后加了截止日期，当天就不再出现', () => {
    time.updateSettings({ dailyPicks: 1 })
    const t = repo.createTask({ title: '梳理科研复现任务', status: 'active' })
    expect(review.get(DAY).picks.map((x) => x.id)).toEqual([t.id])
    repo.updateTask(t.id, { dueDate: '2026-10-16' })
    expect(review.get(DAY).picks).toEqual([])
  })

  it('当天先打开时还没有候选，之后加了任务会补抽', () => {
    time.updateSettings({ dailyPicks: 1 })
    expect(review.get(DAY).picks).toEqual([])
    const t = repo.createTask({ title: '学吉他', status: 'active' })
    expect(review.get(DAY).picks.map((x) => x.id)).toEqual([t.id])
  })

  it('换一批尽量换成没出现过的', () => {
    time.updateSettings({ dailyPicks: 1 })
    const a = repo.createTask({ title: 'a', status: 'active' })
    const b = repo.createTask({ title: 'b', status: 'active' })
    const first = review.get(DAY).picks[0].id
    const second = review.reroll(DAY)[0].id
    expect(second).not.toBe(first)
    expect([a.id, b.id]).toContain(second)
  })

  it('收件箱积压：条数、最旧天数、每周整理日都会触发，关掉后当天记住', () => {
    time.updateSettings({ inboxNagCount: 3, inboxNagDays: 7, weeklyReviewDay: 0 })
    expect(review.get(DAY).tidyNeeded).toBe(false) // 收件箱空

    repo.capture('a')
    expect(review.get(DAY).tidyNeeded).toBe(false)
    repo.capture('b')
    repo.capture('c')
    expect(review.get(DAY).tidyNeeded).toBe(true) // 3 条

    time.updateSettings({ inboxNagCount: 50, weeklyReviewDay: 4 }) // 周四
    expect(review.get(DAY).tidyNeeded).toBe(true)

    time.updateSettings({ weeklyReviewDay: 0 })
    db.prepare(`UPDATE tasks SET created_at = ?`).run(iso(5, 10))
    const r = review.get(DAY)
    expect(r.inbox).toEqual({ count: 3, oldestDays: 10 })
    expect(r.tidyNeeded).toBe(true)

    review.dismissTidy(DAY)
    expect(review.get(DAY).tidyDismissed).toBe(true)
    expect(review.get('2026-10-16').tidyDismissed).toBe(false)
  })
})

describe('daily review', () => {
  it('汇总：计划 / 实际、按大类、跳过的计划、临时插入、待标原因、完成', () => {
    const [study] = repo.listCategories()
    const done = repo.createTask({ title: '线代', status: 'active', categoryId: study.id })
    const skip = repo.createTask({ title: '物理', status: 'active', categoryId: study.id })

    const b1 = time.createBlock({ taskId: done.id, startAt: iso(15, 9), endAt: iso(15, 10) })
    time.createBlock({ taskId: skip.id, startAt: iso(15, 14), endAt: iso(15, 15) })
    time.createBlock({ title: '看番', startAt: iso(15, 21), endAt: iso(15, 22) }) // 还没到，不算跳过

    // 按计划做了线代，超时很多
    clock = local(15, 9)
    time.start({ taskId: done.id, planBlockId: b1.id })
    clock = local(15, 10, 40)
    time.stop({ complete: true })
    // 临时打游戏（晚上补录）
    clock = local(15, 20)
    time.createEntry({ title: '打游戏', startAt: iso(15, 16), endAt: iso(15, 17) })

    const s = review.summary(DAY)
    expect(s.plannedMin).toBe(180)
    expect(s.actualMin).toBe(160)
    expect(s.skipped.map((b) => b.title)).toEqual(['物理'])
    expect(s.unplanned.map((e) => e.title)).toEqual(['打游戏'])
    expect(s.needReason.map((r) => [r.entry.title, r.plannedMin])).toEqual([['线代', 60]])
    expect(s.completed.map((t) => t.title)).toEqual(['线代'])
    const studyRow = s.byCategory.find((c) => c.categoryId === study.id)!
    expect(studyRow).toMatchObject({ plannedMin: 120, actualMin: 100 })
    expect(s.review).toBeNull()
  })

  it('补录的记录和对应计划块比，超时也会问原因', () => {
    const t = repo.createTask({ title: '线代', status: 'active' })
    time.createBlock({ taskId: t.id, startAt: iso(15, 9), endAt: iso(15, 10) })
    time.createEntry({ taskId: t.id, startAt: iso(15, 9), endAt: iso(15, 10, 50) })
    time.createEntry({ title: '散步', startAt: iso(15, 12), endAt: iso(15, 13) }) // 没计划，不问
    expect(review.summary(DAY).needReason.map((r) => [r.entry.title, r.plannedMin])).toEqual([['线代', 60]])
  })

  it('上课时段不算跳过', () => {
    db.prepare(`INSERT INTO courses (id, name, meetings, term_start, updated_at) VALUES ('c1', '高数', '[]', '2026-09-07', '')`).run()
    const b = time.createBlock({ title: '高数', startAt: iso(15, 8), endAt: iso(15, 9) })
    db.prepare(`UPDATE plan_blocks SET course_id = 'c1' WHERE id = ?`).run(b.id)
    expect(review.summary(DAY).skipped).toEqual([])
  })

  it('昨天选的「今天先做」出现在今天；昨天有记录没复盘会提示', () => {
    const t = repo.createTask({ title: '先做这个', status: 'active' })
    expect(review.get('2026-10-16').yesterdayUnreviewed).toBe(false) // 15 号没活动

    time.createEntry({ title: '自习', startAt: iso(15, 9), endAt: iso(15, 10) })
    expect(review.get('2026-10-16').yesterdayUnreviewed).toBe(true)

    review.save(DAY, { tomorrowTaskId: t.id })
    const next = review.get('2026-10-16')
    expect(next.yesterdayUnreviewed).toBe(false)
    expect(next.firstThing?.id).toBe(t.id)
    // 已经在「今天先做」里了，不会再被随机抽到
    expect(next.picks.map((x) => x.id)).not.toContain(t.id)

    repo.updateTask(t.id, { status: 'done' })
    expect(review.get('2026-10-16').firstThing).toBeNull()
  })

  it('保存复盘：可分次填写，校验输入', () => {
    const t = repo.createTask({ title: '明天先做', status: 'active' })
    review.save(DAY, { mood: 4 })
    const r = review.save(DAY, { note: '  下午效率低  ', tomorrowTaskId: t.id })
    expect(r).toMatchObject({ day: DAY, mood: 4, note: '下午效率低', tomorrowTaskId: t.id })
    expect(review.summary(DAY).review?.mood).toBe(4)
    expect(() => review.save(DAY, { mood: 6 as never })).toThrow()
    expect(() => review.save('15/10', {})).toThrow()
  })
})
