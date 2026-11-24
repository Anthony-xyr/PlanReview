import { describe, expect, it } from 'vitest'
import { dayBackground } from './background'

describe('按本机时间选择背景', () => {
  it.each([
    [0, 0, 'night'],
    [4, 59, 'night'], [5, 0, 'dawn'],
    [8, 59, 'dawn'], [9, 0, 'day'],
    [16, 59, 'day'], [17, 0, 'dusk'],
    [19, 59, 'dusk'], [20, 0, 'night'],
    [23, 59, 'night']
  ] as const)('%i:%i → %s', (hour, minute, phase) => {
    expect(dayBackground(new Date(2026, 10, 24, hour, minute))).toBe(phase)
  })
})
