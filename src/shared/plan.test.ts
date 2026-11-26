import { describe, expect, it } from 'vitest'
import {
  combineDateClock,
  countsTowardPlan,
  isCourseBlock,
  isPlayableBlock,
  isReservedBlock,
  matchesBlockEntry,
  resolveEndAt,
  withClock
} from './plan'

describe('plan domain helpers', () => {
  it('区分课表块、任务块与保留时段', () => {
    const course = { taskId: null, courseId: 'c1', taskStatus: null }
    const task = { taskId: 't1', courseId: null, taskStatus: 'active' as const }
    const doneTask = { taskId: 't2', courseId: null, taskStatus: 'done' as const }
    const droppedTask = { taskId: 't3', courseId: null, taskStatus: 'dropped' as const }
    const reserved = { taskId: null, courseId: null, taskStatus: null }

    expect(isCourseBlock(course)).toBe(true)
    expect(countsTowardPlan(course)).toBe(false)
    expect(isReservedBlock(course)).toBe(false)
    expect(isPlayableBlock(course)).toBe(false)

    expect(isCourseBlock(task)).toBe(false)
    expect(countsTowardPlan(task)).toBe(true)
    expect(isReservedBlock(task)).toBe(false)
    expect(isPlayableBlock(task)).toBe(true)

    expect(isPlayableBlock(doneTask)).toBe(false)
    expect(isPlayableBlock(droppedTask)).toBe(false)

    expect(countsTowardPlan(reserved)).toBe(true)
    expect(isReservedBlock(reserved)).toBe(true)
    expect(isPlayableBlock(reserved)).toBe(true)
  })

  it('判断计划块与实际记录是否匹配', () => {
    const taskBlock = { id: 'b1', taskId: 't1', title: '线代' }
    const freeBlock = { id: 'b2', taskId: null, title: '看番' }

    expect(matchesBlockEntry(taskBlock, { planBlockId: 'b1', taskId: null, title: '其他' })).toBe(true)
    expect(matchesBlockEntry(taskBlock, { planBlockId: null, taskId: 't1', title: '其他' })).toBe(true)
    expect(matchesBlockEntry(taskBlock, { planBlockId: null, taskId: 't2', title: '线代' })).toBe(false)

    expect(matchesBlockEntry(freeBlock, { planBlockId: null, taskId: null, title: '看番' })).toBe(true)
    expect(matchesBlockEntry(freeBlock, { planBlockId: null, taskId: 't1', title: '看番' })).toBe(false)
    expect(matchesBlockEntry(freeBlock, { planBlockId: null, taskId: null, title: '打游戏' })).toBe(false)
  })

  it('组合日期与时钟并处理跨零点区间', () => {
    const base = new Date(2026, 9, 15, 8, 30)
    expect(withClock(base, '14:05')).toEqual(new Date(2026, 9, 15, 14, 5, 0, 0))
    expect(combineDateClock('2026-10-15', '09:30')).toEqual(new Date(2026, 9, 15, 9, 30, 0, 0))

    const late = combineDateClock('2026-10-15', '23:00')
    expect(resolveEndAt(late, late, '01:30')).toEqual(new Date(2026, 9, 16, 1, 30, 0, 0))

    const nextDay = new Date(2026, 9, 16, 1, 0)
    expect(resolveEndAt(combineDateClock('2026-10-15', '14:00'), nextDay, '15:30')).toEqual(new Date(2026, 9, 15, 15, 30, 0, 0))
  })
})
