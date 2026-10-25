/** 90 → "1h30m"，45 → "45m" */
export function formatMinutes(min: number | null): string {
  if (min == null) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  if (!h) return `${m}m`
  return m ? `${h}h${m}m` : `${h}h`
}

/** 解析 "1.5h" "90" "1h30m" "45m" 为分钟；空串为 null；无法解析时返回 undefined */
export function parseMinutes(input: string): number | null | undefined {
  const s = input.trim().toLowerCase()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/)
  if (!m || (!m[1] && !m[2])) return undefined
  return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0))
}

/** 截止日期已过（按本地日期，当天不算过期） */
export function isOverdue(dueDate: string | null, today = todayLocal()): boolean {
  return !!dueDate && dueDate < today
}

export function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
