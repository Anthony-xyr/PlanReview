import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/schema'
import { Repo } from './db/repo'
import { DEFAULT_SETTINGS, nextClock, sleepWindow, TimeRepo } from './db/timeRepo'
import { candidates, ReminderCenter, reminderSnapshot, type Snapshot } from './reminders'

// 测试用本地时间
const local = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 15 + dayOffset, h, m)

let db: DatabaseSync
let repo: Repo
let time: TimeRepo
let clock: Date

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
  clock = local(14)
  time = new TimeRepo(db, () => clock)
})

afterEach(() => db.close())

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: clock,
  settings: time.getSettings(),
  running: time.running(),
  blocks: time.listBlocks(new Date(clock.getTime() - 86_400_000).toISOString(), new Date(clock.getTime() + 86_400_000).toISOString()),
  ...over
})

const kinds = (s: Snapshot) => candidates(s).map((c) => c.kind)

/** 每次新建都从数据库读关闭记录，相当于重启软件 */
const newCenter = () => new ReminderCenter(time, db, () => clock)

describe('自由计划块与本次计时', () => {
  const reserve = (title = '推进研究', end = local(15)) =>
    time.createBlock({ title, startAt: local(14).toISOString(), endAt: end.toISOString() })
  const startBlock = (b: ReturnType<typeof reserve>) => time.start({ title: b.title, planBlockId: b.id })

  it('延长后不在原计划结束时提醒，新的目标时刻只提示 session-end', () => {
    const b = reserve()
    const center = newCenter()
    startBlock(b)
    clock = local(14, 58)
    expect(time.extend(15).targetEndAt).toBe(local(15, 15).toISOString())

    clock = local(15)
    expect(kinds(snap())).toEqual([])
    expect(center.evaluate(snap())).toBeNull()
    clock = local(15, 15)
    expect(kinds(snap())).toEqual(['session-end'])
    expect(center.evaluate(snap())?.kind).toBe('session-end')
    clock = local(15, 16)
    expect(time.stop({}).entry?.endAt).toBe(clock.toISOString())
    expect(center.evaluate(snap())).toBeNull()
    expect(newCenter().evaluate(snap())).toBeNull()
    expect(time.getBlock(b.id)?.endAt).toBe(local(15).toISOString())
  })

  it('未延长的计时在原结束时也只提示 session-end', () => {
    startBlock(reserve())
    clock = local(15)
    expect(kinds(snap())).toEqual(['session-end'])
  })

  it.each(['停止', '切换'])('没经过原结束时的 tick，%s后也不补弹', (action) => {
    const center = newCenter()
    const b = reserve()
    startBlock(b)
    time.extend(15)
    clock = local(15, 10)
    if (action === '停止') time.stop({})
    else time.start({ title: '另一件事' })
    expect(center.evaluate(snap())).toBeNull()
    expect(newCenter().evaluate(snap())).toBeNull()
  })

  it('到点停止且计时不足一分钟，丢弃记录时仍不补弹', () => {
    const b = reserve()
    const center = newCenter()
    clock = new Date(local(15).getTime() - 20_000)
    startBlock(b)
    clock = local(15)
    expect(time.stop({})).toEqual({ entry: null, discarded: true })
    expect(center.evaluate(snap())).toBeNull()
  })

  it('停止后原提醒的关闭不影响后来改了结束时间的同一个计划', () => {
    const b = reserve()
    const center = newCenter()
    startBlock(b)
    clock = local(15, 10)
    time.stop({})
    time.updateBlock(b.id, { endAt: local(15, 20).toISOString() })
    clock = local(15, 20)
    expect(center.evaluate(snap())?.id).toBe(`block-end:${b.id}:${clock.toISOString()}`)
  })

  it('只跳过计时对应的块，另一个同名计划依然提醒', () => {
    startBlock(reserve())
    time.extend(15)
    const other = reserve()
    clock = local(15)
    expect(newCenter().evaluate(snap())?.blockId).toBe(other.id)
  })

  it('提前停止后仍正常提醒，满 30 分钟后窗口关闭', () => {
    const b = reserve()
    const center = newCenter()
    startBlock(b)
    clock = local(14, 59)
    time.stop({})
    expect(center.evaluate(snap())).toBeNull()
    clock = local(15)
    expect(center.evaluate(snap())?.blockId).toBe(b.id)
    clock = local(15, 29)
    expect(center.evaluate(snap())?.kind).toBe('block-end')
    clock = local(15, 30)
    expect(center.evaluate(snap())).toBeNull()
  })

  it('从选择器提前启动跨零点自由计划，延长到新目标且不补弹', () => {
    time.updateSettings({ dayStartHour: 0, leaveEnabled: false, sleepStart: '03:00', sleepEnd: '04:00', sleepLeadMin: 0 })
    clock = local(23, 40)
    const block = time.createBlock({ title: '跨日计划', startAt: local(23, 55).toISOString(), endAt: local(0, 10, 1).toISOString() })
    // 悬浮窗提前开始传原时长和 planBlockId，不改计划时段。
    const started = time.start({ title: block.title, planBlockId: block.id, durationMin: 15 })
    expect(started.targetEndAt).toBe(local(23, 55).toISOString())
    clock = local(23, 54)
    expect(time.extend(25).targetEndAt).toBe(local(0, 20, 1).toISOString())
    clock = local(0, 10, 1)
    const center = newCenter()
    expect(center.evaluate(reminderSnapshot(time, clock))).toBeNull()
    clock = local(0, 20, 1)
    expect(center.evaluate(reminderSnapshot(time, clock))?.kind).toBe('session-end')
    time.stop({})
    expect(newCenter().evaluate(reminderSnapshot(time, clock))).toBeNull()
    expect(time.getBlock(block.id)?.endAt).toBe(block.endAt)
  })

  it('越过自定义日界时仍检查前半小时的块，只跳过实际计时过的块', () => {
    time.updateSettings({ dayStartHour: 5, leaveEnabled: false, sleepStart: '03:00', sleepEnd: '04:00', sleepLeadMin: 0 })
    clock = local(4, 40)
    const target = time.createBlock({ title: '提前开始', startAt: local(4, 42).toISOString(), endAt: local(4, 55).toISOString() })
    const other = time.createBlock({ title: '没开始', startAt: local(4, 43).toISOString(), endAt: local(4, 56).toISOString() })
    time.start({ title: target.title, planBlockId: target.id, durationMin: 13 })
    time.extend(15)
    clock = local(5, 5)
    const center = newCenter()
    expect(center.evaluate(reminderSnapshot(time, clock))?.blockId).toBe(other.id)
    time.stop({})
    expect(newCenter().evaluate(reminderSnapshot(time, clock))?.blockId).toBe(other.id)
    clock = local(5, 26)
    expect(center.evaluate(reminderSnapshot(time, clock))).toBeNull()
  })
})

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
    const center = newCenter()
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
    const center = newCenter()
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
    const center = newCenter()
    clock = local(0, 5, 1)
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('sleep-lead')
    center.dismiss(r.id, 'group')
    clock = local(0, 40, 1)
    expect(center.evaluate(snap())).toBeNull()
  })

  it('延长类提醒附带影响', () => {
    const center = newCenter()
    time.createBlock({ title: '物理', startAt: local(14, 40).toISOString(), endAt: local(15, 30).toISOString() })
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('session-end')
    expect(r.impact?.squeezed.map((x) => x.title)).toEqual(['物理'])
  })
})

describe('关闭记录重启后也记得', () => {
  it('本次到点「这次不再提醒」：重启后也不出现；延长后到新的点再提醒', () => {
    time.updateSettings({ leaveEnabled: false })
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const center = newCenter()
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('session-end')
    center.dismiss(r.id)
    clock = local(14, 50)
    expect(newCenter().evaluate(snap())).toBeNull()

    time.extend(15)
    clock = local(15, 6)
    expect(newCenter().evaluate(snap())?.kind).toBe('session-end')
  })

  it('离开自习室「今天不再提醒」：当天重启后也不出现，第二天照常', () => {
    clock = local(21, 55)
    const center = newCenter()
    const r = center.evaluate(snap())!
    expect(r.kind).toBe('leave')
    center.dismiss(r.id, 'group')
    clock = local(22, 30)
    expect(newCenter().evaluate(snap())).toBeNull()

    clock = local(21, 55, 1)
    expect(newCenter().evaluate(snap())?.kind).toBe('leave')
  })

  it('今晚不再提醒：跨过零点、重启后也不出现', () => {
    time.updateSettings({ leaveEnabled: false })
    clock = local(0, 5, 1)
    const center = newCenter()
    center.dismiss(center.evaluate(snap())!.id, 'group')
    clock = local(0, 40, 1)
    expect(newCenter().evaluate(snap())).toBeNull()
  })

  it('稍后再说不存：重启后马上再出现', () => {
    time.start({ title: 'a', durationMin: 30 })
    clock = local(14, 31)
    const center = newCenter()
    center.snooze(center.evaluate(snap())!.id, 5, clock)
    expect(center.evaluate(snap())).toBeNull()
    expect(newCenter().evaluate(snap())?.kind).toBe('session-end')
  })

  it('7 天前的记录启动时清掉', () => {
    db.prepare('INSERT INTO reminder_dismissals (scope, value, created_at) VALUES (?, ?, ?)').run('once', 'old', local(14, 0, -8).toISOString())
    db.prepare('INSERT INTO reminder_dismissals (scope, value, created_at) VALUES (?, ?, ?)').run('group', 'recent', local(14, 0, -6).toISOString())
    newCenter()
    const left = (db.prepare('SELECT value FROM reminder_dismissals').all() as { value: string }[]).map((x) => x.value)
    expect(left).toEqual(['recent'])
  })
})
