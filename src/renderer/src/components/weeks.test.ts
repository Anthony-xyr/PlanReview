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
