import { describe, expect, it } from 'vitest'
import { clockToOffset, dayOf, dayRange, formatElapsed, layoutLanes, overlapMin, shiftDay, snap } from './time'

describe('day', () => {
  it('凌晨在起点之前算前一天', () => {
    expect(dayOf(new Date(2026, 9, 16, 1, 30), 5)).toBe('2026-10-15')
    expect(dayOf(new Date(2026, 9, 16, 6, 0), 5)).toBe('2026-10-16')
  })

  it('一天从起点到次日起点', () => {
    const { start, end } = dayRange('2026-10-31', 5)
    expect(start).toEqual(new Date(2026, 9, 31, 5))
    expect(end).toEqual(new Date(2026, 10, 1, 5))
  })

  it('跨月切换日期', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('时钟换算成偏移', () => {
    expect(clockToOffset('08:00', 5)).toBe(180)
    expect(clockToOffset('00:30', 5)).toBe(1170)
  })

  it('吸附与重叠', () => {
    expect(snap(37)).toBe(30)
    expect(snap(38)).toBe(45)
    expect(overlapMin(0, 60, 30, 90)).toBe(30)
    expect(overlapMin(0, 60, 60, 90)).toBe(0)
  })
})

describe('layoutLanes', () => {
  it('不重叠的都在第一道', () => {
    expect(layoutLanes([{ start: 0, end: 60 }, { start: 60, end: 90 }])).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 }
    ])
  })

  it('重叠的并排，空出的道复用', () => {
    const r = layoutLanes([
      { start: 0, end: 60 },
      { start: 30, end: 90 },
      { start: 60, end: 120 },
      { start: 200, end: 230 }
    ])
    expect(r).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 2 },
      { lane: 0, lanes: 1 }
    ])
  })
})

it('formatElapsed', () => {
  expect(formatElapsed(65_000)).toBe('01:05')
  expect(formatElapsed(3_909_000)).toBe('1:05:09')
})
