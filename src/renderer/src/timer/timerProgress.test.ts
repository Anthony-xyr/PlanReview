import { expect, it } from 'vitest'
import { timerProgress } from './timerProgress'

it('显示剩余、到点、超时；无目标时只显示已用时长', () => {
  const target = '2026-11-23T12:00:00.000Z'
  const end = Date.parse(target)
  expect(timerProgress(null, end)).toBeNull()
  expect(timerProgress(target, end - 1)).toEqual({ label: '剩 1 分钟', over: false })
  expect(timerProgress(target, end)).toEqual({ label: '到点', over: true })
  expect(timerProgress(target, end + 59_999)).toEqual({ label: '到点', over: true })
  expect(timerProgress(target, end + 60_000)).toEqual({ label: '超时 1 分钟', over: true })
})
