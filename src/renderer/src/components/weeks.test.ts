import { expect, it } from 'vitest'
import { textToWeeks, weeksToText } from './ImportDialog'

it('周次文本互转', () => {
  expect(weeksToText([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8')
  expect(weeksToText([4])).toBe('4')
  expect(textToWeeks('1-3, 5，7-8')).toEqual([1, 2, 3, 5, 7, 8])
  expect(textToWeeks('3-1')).toBeNull()
  expect(textToWeeks('abc')).toBeNull()
  expect(textToWeeks('')).toBeNull()
})

it('周复盘：打开时停在本周或最近有记录的一周', async () => {
  const { startWeek } = await import('./WeeklyView')
  const active = ['2026-10-05', '2026-10-12']
  expect(startWeek('2026-10-19', active)).toBe('2026-10-12')
  expect(startWeek('2026-10-12', active)).toBe('2026-10-12')
  expect(startWeek('2026-10-19', [])).toBe('2026-10-19')
  // 只有未来的周有记录（比如提前排的计划）时仍看本周
  expect(startWeek('2026-10-19', ['2026-11-02'])).toBe('2026-10-19')
})

it('周复盘：翻页跳过空周，往后翻到本周为止', async () => {
  const { stepWeek } = await import('./WeeklyView')
  const active = ['2026-09-14', '2026-10-05', '2026-10-12']
  const now = '2026-10-26'
  expect(stepWeek('2026-10-12', -1, now, active)).toBe('2026-10-05')
  expect(stepWeek('2026-09-14', -1, now, active)).toBeNull()
  // 从本周往前跳过空的 10/19
  expect(stepWeek(now, -1, now, active)).toBe('2026-10-12')
  expect(stepWeek('2026-09-14', 1, now, active)).toBe('2026-10-05')
  // 后面没有记录了就回到本周
  expect(stepWeek('2026-10-12', 1, now, active)).toBe(now)
  expect(stepWeek(now, 1, now, active)).toBeNull()
})

it('周复盘：标题', async () => {
  const { weekLabel } = await import('./WeeklyView')
  expect(weekLabel('2026-10-26', '2026-10-26')).toBe('本周')
  expect(weekLabel('2026-10-19', '2026-10-26')).toBe('上周')
  // 跨夏令时 / 年份也按整周算
  expect(weekLabel('2025-12-29', '2026-01-19')).toBe('3 周前')
})
