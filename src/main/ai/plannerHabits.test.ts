import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_MANIFEST, createInvokeBridge, ipcAccessOf } from '@shared/ipc'
import type { CaptureHabit, PlanReplan, SuggestedBlock } from '@shared/types'
import { MAX_HABIT_CHARS } from '@shared/types'
import { makeTask } from '@shared/testFactories'
import { Repo } from '../db/repo'
import { TimeRepo } from '../db/timeRepo'
import { ReviewRepo } from '../db/reviewRepo'
import { WeeklyRepo } from '../db/weeklyRepo'
import { HabitRepo } from '../db/habitRepo'
import { migrate } from '../db/schema'
import { registerAiIpc } from '../ipc/ai'
import { createIpcRegistry } from '../ipc/registry'
import type { AiConfigStore } from './config'
import { AiService } from './service'
import * as client from './client'
import { normalizePlanFeedback, normalizePreviousPlan, plannerMessages, replanDay, replanMessages, sanitizePlan, sanitizeReplan, type PlannerContext } from './planner'

// 用单元素元组包住数组输入，避免参数化测试把畸形数组展开成多个参数。
const cases = (values: unknown[]) => values.map((value) => [value] as const)

const date = (clock: string) => new Date('2026-11-28T' + clock + ':00')
const context = (): PlannerContext => ({ day: '2026-11-28', now: date('09:00'), gaps: [{ start: date('09:00'), end: date('12:00') }], blocks: [], tasks: [], categories: [], insights: ['上午专注'], hint: '留出休息' })
const habit = (id: string, text = id, enabled = true): CaptureHabit => ({ id, text, enabled, example: '', usedCount: 0, lastUsedAt: null, createdAt: date('08:00').toISOString(), updatedAt: date('08:00').toISOString() })
const previous: SuggestedBlock[] = [{ taskId: null, title: '阅读', startAt: date('09:00').toISOString(), endAt: date('10:00').toISOString(), reason: '先阅读' }]
const raw = { blocks: [{ taskId: null, title: '阅读', start: '10:00', end: '11:00' }], notes: [], habit: '先阅读再复现', replaces: 'h1', usedHabits: ['h1'] }
const endpoint = { baseUrl: 'https://example.invalid/v1', apiKey: 'unit-test-only', model: 'fixture' }

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('排程提示词与输出清洗', () => {
  it('无习惯时逐字等于主干原函数，且锁定完整快照', () => {
    const golden = JSON.parse(readFileSync(new URL('./fixtures/plannerPrompt.v030.json', import.meta.url), 'utf8'))
    const messages = plannerMessages(context())
    expect(messages).toEqual(golden.messages)
    expect(plannerMessages({ ...context(), habits: [] })).toEqual(messages)
    expect(messages).toMatchSnapshot('无习惯提示词')
    expect(JSON.stringify(messages)).not.toContain('usedHabits')
  })
  it('只编号启用的排程习惯，并锁定有习惯快照', () => {
    const c = { ...context(), habits: [habit('p1', '先阅读'), habit('off', '停用规则', false), habit('p2', '晚上运动')] }
    const messages = plannerMessages(c)
    expect(messages).toMatchSnapshot('有习惯提示词')
    expect(messages[0].content).toContain('h1：先阅读')
    expect(messages[0].content).toContain('h2：晚上运动')
    expect(messages[0].content).not.toContain('停用规则')
    expect(messages[0].content).toContain('usedHabits')
    expect(plannerMessages({ ...context(), habits: [habit('off', '停用', false)] })).toEqual(plannerMessages(context()))
  })
  it('重排携带旧草稿、最初要求与最近五条已裁剪纠正', () => {
    const notes = normalizePlanFeedback(['  一  ', '', '二', '三', '四', '五', '  ' + '六'.repeat(400) + '  '])
    expect(notes).toHaveLength(5)
    expect(notes[0]).toBe('二')
    expect(notes.at(-1)).toHaveLength(300)
    const messages = replanMessages(context(), previous, notes)
    expect(messages[1].content).toContain('你上次的安排：')
    expect(messages[1].content).toContain('09:00–10:00 阅读')
    expect(messages[1].content).toContain('用户的要求：留出休息')
    expect(messages[1].content).not.toContain('1. 一')
  })
  it.each(cases([undefined, null, '', [], [' ', '\n'], [null, 42, {}]]))('空或畸形 feedback %j 明确报错', (value) => {
    expect(() => normalizePlanFeedback(value)).toThrow('写一句哪里不对')
  })
  it.each(cases([null, {}, '乱码', Array(31).fill(previous[0]), [null], [{}], [{ ...previous[0], startAt: '乱码' }], [{ ...previous[0], endAt: previous[0].startAt }], [{ ...previous[0], reason: undefined }]]))('非法 previous %j 被拒绝', (value) => {
    expect(() => normalizePreviousPlan(value)).toThrow('上一版草稿格式不对')
  })
  it('允许最多30个完整时段，不依赖外部id字段', () => {
    expect(normalizePreviousPlan(Array(30).fill(previous[0]))).toHaveLength(30)
  })
  it.each(cases([null, '乱码', [], {}, { blocks: [null, {}, { start: '99:99', end: '10:00' }], notes: [null, 1, ' 说明 '] }, { blocks: [...raw.blocks, ...raw.blocks, { taskId: 'ghost', title: '', start: '11:00', end: '11:30' }] }]))('重排畸形输出 %j 沿用普通草稿的同一清洗规则', (value) => {
    const a = sanitizePlan(value, context(), 5)
    const b = sanitizeReplan(value, context(), 5)
    expect(b.blocks).toEqual(a.blocks)
    expect(b.notes).toEqual(a.notes)
    expect(b.replacesId).toBeNull()
    expect(b.habit).toBe('')
  })
  it('忽略未知、重复、停用习惯编号，不允许替换速记id', () => {
    const c = { ...context(), habits: [habit('p1'), habit('off', '停用', false)] }
    expect(sanitizeReplan({ ...raw, usedHabits: ['h1', 'H1', 'h0', 'h2', 'h99', 'capture-id'], replaces: 'capture-id' }, c, 5)).toMatchObject({ habitIds: ['p1'], replacesId: null })
    expect(sanitizeReplan(raw, c, 5).replacesId).toBe('p1')
    expect(sanitizeReplan({ ...raw, habit: '  ', replaces: 'h1' }, c, 5)).toMatchObject({ habit: '', replacesId: null })
    expect(sanitizeReplan({ ...raw, habit: '字'.repeat(500) }, c, 5).habit).toHaveLength(MAX_HABIT_CHARS)
    expect(sanitizePlan(raw, context(), 5).habitIds).toEqual([])
  })
  it('重复任务id仍可放在不同时段，同一时段副本继续按重叠规则去掉', () => {
    const c = { ...context(), tasks: [makeTask({ id: 't1', title: '任务' })] }
    const r = sanitizeReplan({ blocks: [{ id: 'same', taskId: 't1', start: '09:00', end: '10:00' }, { id: 'same', taskId: 't1', start: '10:00', end: '11:00' }, { taskId: 't1', start: '09:00', end: '10:00' }] }, c, 5)
    expect(r.blocks).toHaveLength(2)
    expect(r.notes).toContain('有 1 个安排不在空档里或和别的冲突，已去掉')
  })
  it('空纠正和无空档不调用AI', async () => {
    const chat = vi.spyOn(client, 'chat').mockResolvedValue('{}')
    await expect(replanDay(endpoint, context(), previous, [' '], 5)).rejects.toThrow('写一句哪里不对')
    expect(await replanDay(endpoint, { ...context(), gaps: [] }, previous, ['更正'], 5)).toMatchObject({ blocks: [], habit: '', replacesId: null })
    expect(chat).not.toHaveBeenCalled()
  })
})

describe('真实仓储、AiService与IPC协作', () => {
  let db: DatabaseSync
  let service: AiService
  let habits: HabitRepo
  let plannerHabits: HabitRepo
  let time: TimeRepo
  let endpointCall: ReturnType<typeof vi.fn>
  let aiConfig: AiConfigStore
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(date('09:00'))
    db = new DatabaseSync(':memory:'); migrate(db)
    const repo = new Repo(db)
    time = new TimeRepo(db)
    time.updateSettings({ sleepStart: '23:00', sleepEnd: '07:00' })
    habits = new HabitRepo(db)
    plannerHabits = new HabitRepo(db, 'planner')
    endpointCall = vi.fn(() => endpoint)
    aiConfig = { endpoint: endpointCall, effort: () => 'low' } as unknown as AiConfigStore
    service = new AiService({ db, repo, time, habits, plannerHabits, aiConfig, review: new ReviewRepo(db, repo, time), weekly: new WeeklyRepo(db, repo, time) })
  })
  afterEach(() => db.close())
  function ipc() {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const changed = vi.fn()
    const reg = createIpcRegistry({ handle: (channel, fn) => { handlers.set(channel, fn) } }, { isTimerSender: () => false, isFloatMainFrame: () => true, onDataChanged: changed })
    registerAiIpc(reg, { ai: service, aiConfig, habits, plannerHabits })
    const bridge = createInvokeBridge(async (channel, ...args) => handlers.get(channel)!({ sender: {} } as IpcMainInvokeEvent, ...args))
    return { bridge, changed }
  }
  it('replan是read，重排不广播、不落库；accept才一起写计划和planner习惯', async () => {
    const capture = habits.add('原速记')
    const p = plannerHabits.add('旧排程')
    const chat = vi.spyOn(client, 'chat').mockResolvedValue(JSON.stringify(raw))
    const { bridge, changed } = ipc()
    expect(IPC_MANIFEST.planner.replan).toBe('read')
    expect(ipcAccessOf('planner:replan')).toBe('read')
    const result = await bridge.planner.replan('2026-11-28', '', previous, ['先阅读再复现']) as PlanReplan
    expect(changed).not.toHaveBeenCalled()
    expect(plannerHabits.get(p.id)).toEqual(p)
    expect(time.listBlocks(date('08:00').toISOString(), date('23:00').toISOString())).toEqual([])
    expect(chat.mock.calls[0][1][0].content).toContain('h1：旧排程')
    expect(JSON.stringify(chat.mock.calls[0][1])).not.toContain('原速记')
    expect(result.replacesId).toBe(p.id)
    expect(await bridge.planner.accept('2026-11-28', result.blocks, { habitIds: result.habitIds, habit: { text: result.habit, replacesId: result.replacesId } })).toEqual({ created: 1 })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(plannerHabits.get(p.id)).toMatchObject({ text: '先阅读再复现', usedCount: 1 })
    expect(habits.list()).toEqual([capture])
  })
  it('习惯校验或建块失败时，全部回滚且保留原计次', () => {
    const p = plannerHabits.add('旧习惯')
    expect(() => service.acceptDayPlan(previous, { habitIds: [p.id], habit: { text: '字'.repeat(121) } })).toThrow('最多')
    expect(plannerHabits.get(p.id)).toEqual(p)
    expect(time.listBlocks(date('08:00').toISOString(), date('23:00').toISOString())).toEqual([])
    expect(() => service.acceptDayPlan([...previous, { ...previous[0], endAt: '乱码' }], { habit: { text: '不应保存' } })).toThrow()
    expect(plannerHabits.list()).toEqual([p])
    expect(time.listBlocks(date('08:00').toISOString(), date('23:00').toISOString())).toEqual([])
  })
  it('没有勾选记住时，accept只写计划，不写新习惯', () => {
    expect(service.acceptDayPlan(previous)).toEqual({ created: 1 })
    expect(plannerHabits.list()).toEqual([])
  })
  it('accept不能替换capture id；失败也不写计划', () => {
    const c = habits.add('速记')
    expect(() => service.acceptDayPlan(previous, { habit: { text: '越界', replacesId: c.id } })).toThrow('排程习惯已不存在')
    expect(habits.get(c.id)).toEqual(c)
    expect(time.listBlocks(date('08:00').toISOString(), date('23:00').toISOString())).toEqual([])
  })
  it('空反馈/畸形旧草稿在服务层拒绝，不构造AI请求', async () => {
    const chat = vi.spyOn(client, 'chat').mockResolvedValue('{}')
    await expect(service.replanDay('2026-11-28', '', previous, [' '])).rejects.toThrow('写一句哪里不对')
    await expect(service.replanDay('2026-11-28', '', [{}] as SuggestedBlock[], ['更正'])).rejects.toThrow('草稿格式不对')
    expect(endpointCall).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled()
  })
  it('无空档时suggest/replan直接返回空草稿，即使AI未配置也不读取endpoint', async () => {
    time.updateSettings({ sleepStart: '08:00', sleepEnd: '18:00' })
    endpointCall.mockImplementation(() => { throw new Error('不应访问') })
    expect((await service.suggestDayPlan('2026-11-28', '')).blocks).toEqual([])
    expect(await service.replanDay('2026-11-28', '', previous, ['更正'])).toMatchObject({ blocks: [], habit: '', replacesId: null })
    expect(endpointCall).not.toHaveBeenCalled()
  })
  it('五条习惯方法访问级别不变，旧IPC调用与capture相同', async () => {
    const { bridge } = ipc()
    expect(IPC_MANIFEST.habits).toEqual({ list: 'read', add: 'write', update: 'write', remove: 'write', markUsed: 'write' })
    const h = await bridge.habits.add('速记') as CaptureHabit
    expect(await bridge.habits.list()).toEqual(await bridge.habits.list('capture'))
    await bridge.habits.markUsed([h.id], 'capture')
    await bridge.habits.update(h.id, { enabled: false })
    expect(habits.get(h.id)).toMatchObject({ usedCount: 1, enabled: false })
    await bridge.habits.remove(h.id)
    expect(plannerHabits.list()).toEqual([])
  })
  it.each(cases([null, 'unknown', '__proto__', 'constructor', 'toString', {}, 123]))('IPC非法 kind %j 的五种操作都只影响capture', async (kind) => {
    const { bridge } = ipc()
    const p = plannerHabits.add('排程原文')
    const h = await bridge.habits.add('速记', '', null, kind) as CaptureHabit
    expect(await bridge.habits.list(kind)).toEqual([h])
    await bridge.habits.update(h.id, { text: '改写' }, kind)
    await bridge.habits.markUsed([h.id], kind)
    await bridge.habits.remove(h.id, kind)
    expect(habits.list()).toEqual([])
    expect(plannerHabits.list()).toEqual([p])
  })
})
