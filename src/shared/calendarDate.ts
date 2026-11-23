/** 用 UTC 承载年月日，做日历加减时不受夏令时和时区偏移影响。 */
export function parseCalendarDate(value: unknown): Date | null {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  if (year < 1) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}

export function calendarDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function localCalendarKey(date: Date): string {
  return calendarDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export function calendarMonday(date: Date, weeksBack = 0): string {
  const monday = new Date(date.getTime())
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7 - 7 * weeksBack)
  const year = monday.getUTCFullYear()
  if (year < 1 || year > 9999) throw new Error('第一周的日期超出可导入的范围')
  return calendarDateKey(year, monday.getUTCMonth() + 1, monday.getUTCDate())
}
