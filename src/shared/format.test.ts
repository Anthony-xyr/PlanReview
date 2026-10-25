import { describe, expect, it } from 'vitest'
import { formatMinutes, parseMinutes } from './format'

describe('minutes', () => {
  it('格式化', () => {
    expect(formatMinutes(null)).toBe('')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(120)).toBe('2h')
    expect(formatMinutes(90)).toBe('1h30m')
  })

  it('解析', () => {
    expect(parseMinutes('')).toBeNull()
    expect(parseMinutes('90')).toBe(90)
    expect(parseMinutes('1.5h')).toBe(90)
    expect(parseMinutes('1h30m')).toBe(90)
    expect(parseMinutes('45m')).toBe(45)
    expect(parseMinutes('abc')).toBeUndefined()
    expect(parseMinutes('h')).toBeUndefined()
  })
})

it('截止日期是否已过', async () => {
  const { isOverdue } = await import('./format')
  expect(isOverdue('2026-10-21', '2026-10-25')).toBe(true)
  expect(isOverdue('2026-10-25', '2026-10-25')).toBe(false)
  expect(isOverdue(null, '2026-10-25')).toBe(false)
})
