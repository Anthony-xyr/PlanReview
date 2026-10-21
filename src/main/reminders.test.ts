import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/schema'
import { Repo } from './db/repo'
import { DEFAULT_SETTINGS, nextClock, sleepWindow, TimeRepo } from './db/timeRepo'
import { candidates, ReminderCenter, type Snapshot } from './reminders'

// 测试用本地时间
const local = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 15 + dayOffset, h, m)

let repo: Repo
let time: TimeRepo
let clock: Date

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
  clock = local(14)
  time = new TimeRepo(db, () => clock)
})

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: clock,
  settings: time.getSettings(),
  running: time.running(),
  blocks: time.listBlocks(new Date(clock.getTime() - 86_400_000).toISOString(), new Date(clock.getTime() + 86_400_000).toISOString()),
  ...over
})

const kinds = (s: Snapshot) => candidates(s).map((c) => c.kind)

describe('clock helpers', () => {
  it('nextClock 取下一次出现', () => {
    expect(nextClock(local(23), '00:30')).toEqual(local(0, 30, 1))
    expect(nextClock(local(0, 10), '00:30')).toEqual(local(0, 30))
  })

  it('睡眠窗口跨零点', () => {
    const cfg = { sleepStart: '00:30', sleepEnd: '08:00' }
    expect(sleepWindow(local(23), cfg)).toEqual({ start: local(0, 30, 1), end: local(8, 0, 1), inside: false })
    expect(sleepWindow(local(1, 0, 1), cfg).inside).toBe(true)
    expect(sleepWindow(local(9, 0, 1), cfg).inside).toBe(false)
  })

  it('睡眠窗口不跨零点', () => {
    const cfg = { sleepStart: '23:00', sleepEnd: '23:59' }
    expect(sleepWindow(local(23, 30), cfg).inside).toBe(true)
    expect(sleepWindow(local(22, 0), cfg).inside).toBe(false)
  })
})

describe('session timer', () => {
  it('从任务开始计时用默认本次时长；从计划块开始用块的剩余时长', () => {
    const t = repo.capture('a')
    expect(time.start({ taskId: t.id }).plannedMin).toBe(DEFAULT_SETTINGS.defaultSessionMin)
    const b = time.createBlock({ taskId: t.id, startAt: local(13, 30).toISOString(), endAt: local(15).toISOString() })
    const e = time.start({ taskId: t.id, planBlockId: b.id })
    expect(e.plannedMin).toBe(60)
    expect(e.targetEndAt).toBe(local(15).toISOString())
    expect(time.start({ title: 'x', durationMin: null }).targetEndAt).toBeNull()
  })

  it('延长只推后本次目标，不改原计划', () => {
    const t = repo.capture('a')
    const b = time.createBlock({ taskId: t.id, startAt: local(14).toISOString(), endAt: local(15).toISOString() })
    time.start({ taskId: t.id, planBlockId: b.id })
    clock = local(15, 5)
    const e = time.extend(15)
    expect(e.targetEndAt).toBe(local(15, 20).toISOString())
    expect(e.extendedMin).toBe(15)
    expect(time.getBlock(b.id)?.endAt).toBe(local(15).toISOString())
  })

  it('超时判断与原因', () => {
    time.start({ title: 'a', durationMin: 60 })
    clock = local(15, 10)
    expect(time.isOverrun(time.running()!)).toBe(false)
    clock = local(15, 20)
    expect(time.isOverrun(time.running()!)).toBe(true)
    const r = time.stop({ overrunReason: 'scope' })
    expect(r.entry?.overrunReason).toBe('scope')
  })
})

describe('impact', () => {
  it('列出会被挤占的计划和距睡眠时间', () => {
    const t = repo.capture('a')
    time.createBlock({ title: '物理', startAt: local(15).toISOString(), endAt: local(16).toISOString() })
    time.createBlock({ title: '看番', startAt: local(22).toISOString(), endAt: local(23).toISOString() })
    time.start({ taskId: t.id })
    const i = time.impact(local(15, 30))
    expect(i.squeezed.map((x) => x.title)).toEqual(['物理'])
    expect(i.minutesToSleep).toBe(10 * 60 + 30)
    expect(i.remainingPlannedMin).toBe(120)
  })
})

describe('candidates', () => {
  it('到点提醒，带上结束 / 延长所需信息', () => {
    time.start({ title: '线代', durationMin: 30 })
    clock = local(14, 29)
    expect(kinds(snap())).toEqual([])
    clock = local(14, 31)
    const c = candidates(snap())[0]
    expect(c.kind).toBe('session-end')
    expect(c.strong).toBe(false)
  })

  it('睡前预告与进入睡眠窗口都是强提醒，进入后优先级最高', () => {
    time.updateSettings({ leaveEnabled: false })
    clock = local(0, 5, 1)
    expect(kinds(snap())).toEqual(['sleep-lead'])
    clock = local(0, 40, 1)
    time.start({ title: '打游戏', durationMin: 5 })
    clock = local(0, 50, 1)
    const c = candidates(snap())
    expect(c[0].kind).toBe('sleep')
    expect(c[0].strong).toBe(true)
    expect(c.map((x) => x.kind)).toContain('session-end')
  })

  it('自习室离开提醒在提前量内出现，一小时后消失', () => {
    clock = local(21, 49)
    expect(kinds(snap())).not.toContain('leave')
    clock = local(21, 51)
    expect(kinds(snap())).toContain('leave')
    clock = local(23, 1)
    expect(kinds(snap())).not.toContain('leave')
  })

  it('计划块开始时提醒；已经在做这件事就不提醒', () => {
    const t = repo.capture('物理')
    time.createBlock({ taskId: t.id, startAt: local(14).toISOString(), endAt: local(15).toISOString() })
    clock = local(14, 2)
    expect(kinds(snap())).toContain('block-start')
    time.start({ taskId: t.id })
    expect(kinds(snap())).not.toContain('block-start')
  })

  it('保留时段结束提醒', () => {
    time.createBlock({ title: '看番', startAt: local(13).toISOString(), endAt: local(14).toISOString() })
    clock = local(14, 3)
    expect(kinds(snap())).toContain('block-end')
  })

  it('上课时段不提醒开始和结束', () => {
    const base = time.createBlock({ title: '线代', startAt: local(14).toISOString(), endAt: local(15).toISOString() })
    const course = { ...base, courseId: 'c1' }
    clock = local(14, 2)
    expect(kinds(snap({ blocks: [course] }))).toEqual([])
    clock = local(15, 3)
    expect(kinds(snap({ blocks: [course] }))).toEqual([])
  })
})

describe('ReminderCenter', () => {
  it('关闭后同一提醒不再出现；延长后到新的点再提醒', () => {
    const center = new ReminderCenter(time)
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const r = center.evaluate(snap())!
    expect(r.fresh).toBe(true)
    expect(center.evaluate(snap())?.fresh).toBe(false)
    center.dismiss(r.id)
    expect(center.evaluate(snap())).toBeNull()
    time.extend(15)
    clock = local(14, 47)
    expect(center.evaluate(snap())?.kind).toBe('session-end')
  })

  it('稍后提醒到时间才再出现', () => {
    const center = new ReminderCenter(time)
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const r = center.evaluate(snap())!
    center.snooze(r.id, 10, clock)
    clock = local(14, 35)
    expect(center.evaluate(snap())).toBeNull()
    clock = local(14, 42)
    expect(center.evaluate(snap())?.kind).toBe('session-end')
  })

  it('今晚不再提醒：同组都不出现', () => {
    time.updateSettings({ leaveEnabled: false })
    const center = new ReminderCenter(time)
    clock = local(0, 5, 1)
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('sleep-lead')
    center.dismiss(r.id, 'group')
    clock = local(0, 40, 1)
    expect(center.evaluate(snap())).toBeNull()
  })

  it('延长类提醒附带影响', () => {
    const center = new ReminderCenter(time)
    time.createBlock({ title: '物理', startAt: local(14, 40).toISOString(), endAt: local(15, 30).toISOString() })
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('session-end')
    expect(r.impact?.squeezed.map((x) => x.title)).toEqual(['物理'])
  })
})
