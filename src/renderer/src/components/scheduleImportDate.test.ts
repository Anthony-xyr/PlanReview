import { expect, it } from 'vitest'
import { requiresFallbackConfirmation, scheduleImportDateError } from './scheduleImportDate'

it('试算日期必须显式确认，追加和替换共用同一个导入门槛', () => {
  const fallback = '2026-11-23'
  expect(scheduleImportDateError(fallback, fallback, false)).toMatch(/核对并确认/)
  expect(scheduleImportDateError(fallback, fallback, true)).toBeNull()
  expect(scheduleImportDateError(fallback, null, false)).toBeNull()
  expect(requiresFallbackConfirmation('2026-09-07', fallback)).toBe(false)
  expect(scheduleImportDateError('2026-09-07', fallback, false)).toBeNull()
  expect(scheduleImportDateError('2026-02-31', fallback, true)).toMatch(/有效/)
  expect(scheduleImportDateError('', fallback, true)).toMatch(/有效/)
})
