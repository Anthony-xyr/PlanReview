import { describe, expect, it } from 'vitest'
import {
  makeCaptureDraft,
  makeCategory,
  makePlanBlock,
  makeTask,
  makeTimeEntry,
  makeWeekDay,
  makeWeekStats
} from './testFactories'

describe('testFactories', () => {
  it('provides valid defaults and applies overrides', () => {
    expect(makeCategory({ id: 'c2', name: '运动' })).toMatchObject({
      id: 'c2',
      name: '运动',
      archived: false
    })

    const task = makeTask({ id: 't1', status: 'inbox', estimateMin: 45 })
    expect(task).toMatchObject({
      id: 't1',
      status: 'inbox',
      estimateMin: 45,
      tags: [],
      spentMin: 0
    })

    const block = makePlanBlock({ id: 'b1', taskId: 't1', location: 'A101' })
    expect(block).toMatchObject({
      id: 'b1',
      taskId: 't1',
      location: 'A101',
      courseId: null
    })

    const entry = makeTimeEntry({ id: 'e1', source: 'manual', plannedMin: 30 })
    expect(entry).toMatchObject({
      id: 'e1',
      source: 'manual',
      plannedMin: 30,
      extendedMin: 0,
      endAt: null
    })

    const draft = makeCaptureDraft({ title: '作业', dueDate: '2026-10-20' })
    expect(draft).toMatchObject({
      title: '作业',
      dueDate: '2026-10-20',
      tags: []
    })

    const stats = makeWeekStats({ completed: 3 })
    expect(stats.days).toHaveLength(7)
    expect(stats.completed).toBe(3)
    expect(makeWeekDay({ actualMin: 60 }).actualMin).toBe(60)
  })

  it('returns fresh mutable collections per call', () => {
    const first = makeTask()
    first.tags.push('mutated')
    expect(makeTask().tags).toEqual([])

    const draft = makeCaptureDraft()
    draft.tags.push('mutated')
    expect(makeCaptureDraft().tags).toEqual([])

    const stats = makeWeekStats()
    stats.days[0].byCategory.c1 = 10
    expect(makeWeekStats().days[0].byCategory).toEqual({})
  })
})
