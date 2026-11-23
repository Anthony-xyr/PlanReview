import { parseCalendarDate } from '@shared/calendarDate'

export function requiresFallbackConfirmation(termStart: string, fallback: string | null): boolean {
  return fallback !== null && termStart === fallback
}

export function scheduleImportDateError(termStart: string, fallback: string | null, confirmed: boolean): string | null {
  if (!parseCalendarDate(termStart)) return '请填写有效的第一周日期。'
  if (requiresFallbackConfirmation(termStart, fallback) && !confirmed) return '请先核对并确认试算的第一周日期。'
  return null
}
