import { describe, expect, it } from 'vitest'
import type { PlanBlock, Task, WeekStats } from '@shared/types'
import { DEFAULT_SETTINGS } from '../db/timeRepo'
import { sanitizeAction, sanitizeWeekly, weekContextText } from './weekly'
import { freeGaps, sanitizePlan, type PlannerContext } from './planner'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `任务${id}`,
  notes: '',
  status: 'active',
  categoryId: null,
  tags: [],
  estimateMin: 120,
  nextStep: '',
  sourceTaskId: null,
  dueDate: null,
  reviewDate: null,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
  spentMin: 30,
  ...over
})

const stats: WeekStats = {
  weekStart: '2026-10-12',
  days: Array.from({ length: 7 }, (_, i) => ({
    day: `2026-10-${12 + i}`,
    plannedMin: 120,
    actualMin: 90,
    byCategory: { c1: 90 },
    sleepWindowMin: i === 1 ? 60 : 0,
    lastEndAt: null,
    mood: null
  })),
  plannedMin: 840,
  actualMin: 630,
  fulfilment: 0.6,
  byCategory: [{ categoryId: 'c1', plannedMin: 840, actualMin: 630 }],
  estimates: [{ taskId: 't1', title: '实验报告', categoryId: 'c1', estimateMin: 60, spentMin: 90 }],
  reasons: [{ reason: 'scope', count: 2, minutes: 70 }],
  completed: 3,
  created: 5,
  spinOffs: 1,
  reviewedDays: 4
}

describe('weekly context', () => {
  it('包含合计、每天、估时、原因、复盘和画像', () => {
    const text = weekContextText({
      stats,
      notes: [{ day: '2026-10-13', mood: 2, note: '晚上打游戏停不下来' }],
      categories: [{ id: 'c1', name: '学习', color: '#000', sort: 0, archived: false }],
      settings: DEFAULT_SETTINGS,
      openTasks: [task('t9')],
      insights: ['编程类估时偏低']
    })
    expect(text).toContain('计划兑现率 60%')
    expect(text).toContain('周二 2026-10-13')
    expect(text).toContain('睡眠窗口内 1h')
    expect(text).toContain('「实验报告」[学习]：1h30m / 1h（150%）')
    expect(text).toContain('范围扩大：2 次')
    expect(text).toContain('晚上打游戏停不下来')
    expect(text).toContain('id=t9')
    expect(text).toContain('编程类估时偏低')
  })
})

describe('sanitize weekly', () => {
  const ids = new Set(['t9'])

  it('改动白名单：越界、未知 key、不存在的任务都降级为只是建议', () => {
    expect(sanitizeAction({ kind: 'setting', key: 'defaultSessionMin', value: 40 }, ids)).toEqual({ kind: 'setting', key: 'defaultSessionMin', value: 40 })
    expect(sanitizeAction({ kind: 'setting', key: 'defaultSessionMin', value: 4000 }, ids)).toEqual({ kind: 'none' })
    expect(sanitizeAction({ kind: 'setting', key: 'hotkey', value: 'Ctrl+Q' }, ids)).toEqual({ kind: 'none' })
    expect(sanitizeAction({ kind: 'setting', key: 'leaveTime', value: '21:30' }, ids)).toEqual({ kind: 'setting', key: 'leaveTime', value: '21:30' })
    expect(sanitizeAction({ kind: 'setting', key: 'leaveTime', value: '25:00' }, ids)).toEqual({ kind: 'none' })
    expect(sanitizeAction({ kind: 'estimate', taskId: 't9', estimateMin: 180 }, ids)).toEqual({ kind: 'estimate', taskId: 't9', estimateMin: 180 })
    expect(sanitizeAction({ kind: 'estimate', taskId: 'nope', estimateMin: 180 }, ids)).toEqual({ kind: 'none' })
    expect(sanitizeAction({ kind: 'delete_everything' }, ids)).toEqual({ kind: 'none' })
  })

  it('截断数量，补 id 和状态，空结果报错', () => {
    const r = sanitizeWeekly(
      {
        summary: '还行',
        wins: ['a', 'b', 'c', 'd'],
        patterns: [1, 'p'],
        suggestions: Array.from({ length: 6 }, (_, i) => ({ title: `s${i}`, evidence: 'e', action: { kind: 'none' } })),
        insights: [{ text: 'x', evidence: 'y' }, { text: '' }, { text: 'z' }, { text: 'w' }]
      },
      ids
    )
    expect(r.report.wins).toHaveLength(3)
    expect(r.report.patterns).toEqual(['p'])
    expect(r.report.suggestions).toHaveLength(4)
    expect(r.report.suggestions[0]).toMatchObject({ title: 's0', status: 'open' })
    expect(r.report.suggestions[0].id).toBeTruthy()
    expect(r.insights.map((i) => i.text)).toEqual(['x', 'z'])
    expect(() => sanitizeWeekly({}, ids)).toThrow()
  })
})

describe('planner', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m)
  const block = (s: Date, e: Date): PlanBlock => ({ id: 'b', taskId: null, title: '课', categoryId: null, taskStatus: null, startAt: s.toISOString(), endAt: e.toISOString(), courseId: null, location: '' })

  it('空档：扣掉已有计划、对齐 5 分钟、丢掉碎片', () => {
    const gaps = freeGaps(at(13, 2), at(18), [block(at(14), at(15, 50)), block(at(16), at(17))])
    expect(gaps.map((g) => [g.start.getHours() * 60 + g.start.getMinutes(), g.end.getHours() * 60 + g.end.getMinutes()])).toEqual([
      [13 * 60 + 5, 14 * 60],
      [17 * 60, 18 * 60]
    ])
  })

  it('只保留落在空档里、不冲突、任务存在的块', () => {
    const ctx: PlannerContext = {
      day: '2026-10-16',
      now: at(13),
      gaps: [{ start: at(13), end: at(15) }, { start: at(23), end: at(25) }],
      blocks: [],
      tasks: [task('t1', { title: '线代' })],
      categories: [],
      insights: [],
      hint: ''
    }
    const r = sanitizePlan(
      {
        blocks: [
          { taskId: 't1', start: '13:00', end: '14:00', reason: '上午精力好' },
          { taskId: 't1', start: '13:30', end: '14:30' }, // 冲突
          { taskId: null, title: '休息', start: '14:00', end: '14:20' },
          { taskId: 'ghost', title: '', start: '14:20', end: '14:50' }, // 任务不存在且无标题
          { taskId: null, title: '看番', start: '15:30', end: '16:30' }, // 不在空档
          { taskId: null, title: '夜读', start: '00:00', end: '00:40' } // 凌晨，算到第二天
        ],
        notes: ['留了休息']
      },
      ctx,
      5
    )
    expect(r.blocks.map((b) => [b.title, b.taskId])).toEqual([
      ['线代', 't1'],
      ['休息', null],
      ['夜读', null]
    ])
    expect(r.notes[0]).toBe('留了休息')
    expect(r.notes[1]).toContain('3 个')
  })
})
