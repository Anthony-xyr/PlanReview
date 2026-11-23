import { formatElapsed, MIN_MS } from '@shared/time'

export function desktopElapsed(ms: number): string {
  const elapsed = formatElapsed(ms)
  return elapsed.length === 5 ? `00:${elapsed}` : elapsed.padStart(8, '0')
}

export function timerProgress(targetEndAt: string | null, now: number): { label: string; over: boolean } | null {
  if (!targetEndAt) return null
  const delta = Date.parse(targetEndAt) - now
  if (delta > 0) return { label: `剩 ${Math.ceil(delta / MIN_MS)} 分钟`, over: false }
  if (delta > -MIN_MS) return { label: '到点', over: true }
  return { label: `超时 ${Math.floor(-delta / MIN_MS)} 分钟`, over: true }
}
