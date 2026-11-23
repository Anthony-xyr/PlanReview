import { expect, it } from 'vitest'
import { closedPicker, pickerArrowIndex, pickerState } from './pickerState'

it('Escape 先清除筛选，再关闭，主动收起或窗口隐藏后下次打开没有旧条件', () => {
  const open = pickerState(closedPicker, { type: 'open' })
  const filtered = pickerState(open, { type: 'query', query: '研究' })
  const clear = pickerState(filtered, { type: 'escape' })
  expect(clear).toEqual({ open: true, query: '' })
  expect(pickerState(clear, { type: 'escape' })).toEqual(closedPicker)
  expect(pickerState(pickerState(filtered, { type: 'reset' }), { type: 'open' })).toEqual(open)
  expect(pickerState(closedPicker, { type: 'query', query: '旧条件' })).toEqual(closedPicker)
})

it('方向键能进入结果和返回搜索框，无结果时留在搜索框', () => {
  expect(pickerArrowIndex(-1, 3, 1)).toBe(0)
  expect(pickerArrowIndex(0, 3, -1)).toBe(-1)
  expect(pickerArrowIndex(-1, 3, -1)).toBe(2)
  expect(pickerArrowIndex(2, 3, 1)).toBe(2)
  expect(pickerArrowIndex(-1, 0, 1)).toBe(-1)
})
