import { describe, expect, it } from 'vitest'
import { MAX_HABITS, MAX_HABIT_CHARS, OVERRUN_REASONS, REASONING_EFFORTS } from './types'

describe('共享类型旧入口的运行时兼容', () => {
  it('保留原路径的四个常量及其内容', () => {
    expect(OVERRUN_REASONS).toEqual([
      { value: 'estimate', label: '估时偏差', hint: '这件事本来就需要更久' },
      { value: 'scope', label: '范围扩大', hint: '做着做着多出了内容' },
      { value: 'interrupted', label: '受干扰', hint: '被打断或环境不好' },
      { value: 'record_error', label: '记录有误', hint: '忘了停表之类' },
      { value: 'unknown', label: '说不清', hint: '' }
    ])
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high'])
    expect(MAX_HABITS).toBe(30)
    expect(MAX_HABIT_CHARS).toBe(120)
  })
})
