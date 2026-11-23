import { expect, it } from 'vitest'
import { desktopElapsed, timerProgress } from './timerProgress'

it('秒、分和小时换位保持同样的数字槽，负计时归零', () => {
  expect([-1, 9_000, 10_000, 59_000, 60_000, 3_599_000, 3_600_000].map(desktopElapsed)).toEqual([
    '00:00:00', '00:00:09', '00:00:10', '00:00:59', '00:01:00', '00:59:59', '01:00:00'
  ])
  expect(desktopElapsed(100 * 3_600_000)).toBe('100:00:00')
})

it('显示剩余、到点、超时；无目标时只显示已用时长', () => {
  const target = '2026-11-23T12:00:00.000Z'
  const end = Date.parse(target)
  expect(timerProgress(null, end)).toBeNull()
  expect(timerProgress(target, end - 1)).toEqual({ label: '剩 1 分钟', over: false })
  expect(timerProgress(target, end)).toEqual({ label: '到点', over: true })
  expect(timerProgress(target, end + 59_999)).toEqual({ label: '到点', over: true })
  expect(timerProgress(target, end + 60_000)).toEqual({ label: '超时 1 分钟', over: true })
})
