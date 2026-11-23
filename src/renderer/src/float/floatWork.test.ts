import { describe, expect, it } from 'vitest'
import type { PlanBlock, Task } from '@shared/types'
import { matchesPickerQuery, planTimerInput, selectFloatWork } from './floatWork'

const at = (time: string) => `2026-11-23T${time}:00.000Z`
const task = (id: string, status: Task['status'] = 'active'): Task => ({ id, status } as Task)
const block = (id: string, startAt: string, endAt: string, fields: Partial<PlanBlock> = {}): PlanBlock => ({
  id, startAt: at(startAt), endAt: at(endAt), title: id, location: '', taskId: null, courseId: null, categoryId: null, taskStatus: null, ...fields
})

describe('悬浮窗任务选择', () => {
  it('按整天判定待安排：过去时段也计入，收件箱、已结束事项不列出', () => {
    const tasks = [task('past'), task('later'), task('pick'), task('inbox', 'inbox'), task('done', 'done')]
    const blocks = [block('morning', '09:00', '09:30', { taskId: 'past' }), block('later', '13:00', '14:30', { taskId: 'later' })]
    expect(selectFloatWork(tasks, blocks, new Set(), new Date(at('12:00'))).unscheduled.map((t) => t.id)).toEqual(['pick'])
  })

  it('稍后计划按时间排序，排除课表、已计时、已完成、放弃和刚开始的时段', () => {
    const later = block('later', '14:00', '16:00')
    const next = block('next', '12:15', '13:00')
    const current = block('current', '12:00', '12:15')
    const blocks = [later, next, current,
      block('done', '12:05', '13:00', { taskStatus: 'done' }), block('dropped', '12:05', '13:00', { taskStatus: 'dropped' }),
      block('course', '12:10', '13:00', { courseId: 'c' }), block('started', '12:10', '13:00'), block('past', '11:00', '12:00')]
    expect(selectFloatWork([], blocks, new Set(['started']), new Date(at('12:00')))).toEqual({
      unscheduled: [], current, upcoming: [next, later]
    })
  })

  it('支持中文、多关键词与大小写无关的筛选', () => {
    expect(matchesPickerQuery(['复盘 ＡＰＩ', '项目'], ' 项目 api ')).toBe(true)
    expect(matchesPickerQuery(['复盘 ＡＰＩ', '项目'], '复盘 下周')).toBe(false)
    expect(matchesPickerQuery(['复盘'], '  ')).toBe(true)
  })

  it('提前开始用原时长，当前时段仍走现有剩余时长，保留计划和任务关联', () => {
    const b = block('实验', '13:00', '13:45', { taskId: 'task', categoryId: 'cat' })
    expect(planTimerInput(b, new Date(at('12:00')))).toMatchObject({ taskId: 'task', planBlockId: b.id, categoryId: 'cat', durationMin: 45 })
    expect(planTimerInput(b, new Date(at('13:05')))).not.toHaveProperty('durationMin')
    expect(planTimerInput({ ...b, taskId: null }, new Date(at('12:00'))).title).toBe('实验')
  })
})
