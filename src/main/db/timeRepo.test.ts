import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { Repo } from './repo'
import { TimeRepo } from './timeRepo'

let repo: Repo
let time: TimeRepo
let clock: Date

const at = (hhmm: string) => `2026-10-15T${hhmm}:00.000Z`
const setNow = (hhmm: string) => (clock = new Date(at(hhmm)))

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
  setNow('12:00')
  time = new TimeRepo(db, () => clock)
})

describe('plan blocks', () => {
  it('关联任务的计划跟随任务标题，收件箱任务排进计划后变成待办', () => {
    const t = repo.capture('线代')
    const b = time.createBlock({ taskId: t.id, startAt: at('14:00'), endAt: at('15:00') })
    expect(b.title).toBe('线代')
    expect(repo.getTask(t.id)?.status).toBe('active')
    repo.updateTask(t.id, { title: '线代第三章' })
    expect(time.getBlock(b.id)?.title).toBe('线代第三章')
  })

  it('保留时段不需要任务', () => {
    const b = time.createBlock({ title: '看番', startAt: at('22:00'), endAt: at('23:00') })
    expect(b.taskId).toBeNull()
    expect(b.title).toBe('看番')
  })

  it('校验时间与名称', () => {
    expect(() => time.createBlock({ title: 'x', startAt: at('15:00'), endAt: at('14:00') })).toThrow()
    expect(() => time.createBlock({ title: ' ', startAt: at('14:00'), endAt: at('15:00') })).toThrow()
  })

  it('按区间查询重叠的计划', () => {
    time.createBlock({ title: 'a', startAt: at('08:00'), endAt: at('09:00') })
    time.createBlock({ title: 'b', startAt: at('09:00'), endAt: at('10:00') })
    expect(time.listBlocks(at('08:30'), at('09:00')).map((b) => b.title)).toEqual(['a'])
  })

  it('拖动后只改时间', () => {
    const b = time.createBlock({ title: 'a', startAt: at('08:00'), endAt: at('09:00') })
    const u = time.updateBlock(b.id, { startAt: at('10:00'), endAt: at('11:30') })
    expect(u.title).toBe('a')
    expect(u.endAt).toBe(at('11:30'))
  })
})

describe('timer', () => {
  it('结束本次投入与完成任务分开', () => {
    const t = repo.capture('写报告')
    time.start({ taskId: t.id })
    setNow('12:40')
    const r = time.stop({ nextStep: '补实验数据' })
    expect(r.entry?.endAt).toBe(at('12:40'))
    const after = repo.getTask(t.id)!
    expect(after.status).toBe('active')
    expect(after.nextStep).toBe('补实验数据')
    expect(after.spentMin).toBe(40)
  })

  it('停止时可以顺手完成任务', () => {
    const t = repo.capture('a')
    time.start({ taskId: t.id })
    setNow('12:10')
    time.stop({ complete: true })
    expect(repo.getTask(t.id)?.status).toBe('done')
  })

  it('不足 1 分钟的计时丢弃', () => {
    time.start({ title: '误点' })
    clock = new Date(clock.getTime() + 30_000)
    expect(time.stop({})).toEqual({ entry: null, discarded: true })
    expect(time.listEntries(at('00:00'), at('23:59'))).toHaveLength(0)
  })

  it('开始新计时会先停掉旧的', () => {
    time.start({ title: 'a' })
    setNow('12:20')
    time.start({ title: 'b' })
    const entries = time.listEntries(at('00:00'), at('23:59'))
    expect(entries.map((e) => [e.title, e.endAt])).toEqual([
      ['a', at('12:20')],
      ['b', null]
    ])
    expect(time.running()?.title).toBe('b')
  })

  it('总估时与多次投入分开累计', () => {
    const t = repo.createTask({ title: '大作业', estimateMin: 180 })
    time.start({ taskId: t.id })
    setNow('13:00')
    time.stop({})
    time.createEntry({ taskId: t.id, startAt: at('09:00'), endAt: at('09:30') })
    const after = repo.getTask(t.id)!
    expect(after.estimateMin).toBe(180)
    expect(after.spentMin).toBe(90)
  })
})

describe('manual entries', () => {
  it('补录与计时同等对待，不能重叠、不能晚于现在', () => {
    time.createEntry({ title: '自习', startAt: at('08:00'), endAt: at('10:00') })
    expect(() => time.createEntry({ title: 'x', startAt: at('09:00'), endAt: at('11:00') })).toThrow(/重叠/)
    expect(() => time.createEntry({ title: 'x', startAt: at('11:00'), endAt: at('13:00') })).toThrow()
    expect(time.createEntry({ title: 'y', startAt: at('10:00'), endAt: at('11:00') }).source).toBe('manual')
  })

  it('补录不能和正在进行的计时重叠', () => {
    setNow('11:00')
    time.start({ title: 'a' })
    setNow('12:00')
    expect(() => time.createEntry({ title: 'x', startAt: at('11:30'), endAt: at('11:45') })).toThrow(/重叠/)
  })

  it('修改记录时排除自身', () => {
    const e = time.createEntry({ title: 'a', startAt: at('08:00'), endAt: at('09:00') })
    expect(time.updateEntry(e.id, { endAt: at('09:30') }).endAt).toBe(at('09:30'))
  })

  it('原计划不随实际记录改变', () => {
    const t = repo.capture('a')
    const b = time.createBlock({ taskId: t.id, startAt: at('08:00'), endAt: at('09:00') })
    time.createEntry({ taskId: t.id, startAt: at('08:00'), endAt: at('10:30') })
    expect(time.getBlock(b.id)?.endAt).toBe(at('09:00'))
  })

  it('删除任务后计划与记录保留原标题', () => {
    const t = repo.capture('读论文')
    const b = time.createBlock({ taskId: t.id, startAt: at('14:00'), endAt: at('15:00') })
    const e = time.createEntry({ taskId: t.id, startAt: at('08:00'), endAt: at('09:00') })
    repo.deleteTask(t.id)
    expect(time.getBlock(b.id)?.title).toBe('读论文')
    expect(time.getEntry(e.id)?.title).toBe('读论文')
  })
})

describe('settings', () => {
  it('默认值与校验', () => {
    expect(time.getSettings().dayStartHour).toBe(5)
    expect(time.updateSettings({ sleepStart: '01:00' }).sleepStart).toBe('01:00')
    expect(() => time.updateSettings({ sleepStart: '25:00' })).toThrow()
    expect(() => time.updateSettings({ dayStartHour: 20 })).toThrow()
  })
})
