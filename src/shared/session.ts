import type { Impact, TimeEntry } from './types'
import { formatMinutes } from './format'

const MIN = 60_000

/** 本次已进行的分钟数 */
export function elapsedMin(e: TimeEntry, now: Date = new Date()): number {
  const end = e.endAt ? new Date(e.endAt) : now
  return (end.getTime() - new Date(e.startAt).getTime()) / MIN
}

/** 距本次目标还剩多少分钟；负数表示已超出；没有目标时为 null */
export function remainingMin(e: TimeEntry, now: Date = new Date()): number | null {
  if (!e.targetEndAt) return null
  return (new Date(e.targetEndAt).getTime() - now.getTime()) / MIN
}

/** 实际是否明显超过本次计划（与主进程 TimeRepo.isOverrun 一致） */
export function isOverrun(e: TimeEntry, ratio: number, now: Date = new Date()): boolean {
  if (!e.plannedMin) return false
  return elapsedMin(e, now) > e.plannedMin * (1 + ratio)
}

/** 把影响写成一两句话 */
export function describeImpact(i: Impact, extendMin?: number): string[] {
  const lines: string[] = []
  if (i.squeezed.length) {
    const names = i.squeezed.slice(0, 3).map((b) => `「${b.title}」`).join('、')
    lines.push(`${extendMin ? `再做 ${extendMin} 分钟，` : ''}会挤到 ${names}${i.squeezed.length > 3 ? ' 等' : ''}`)
  }
  if (i.minutesToSleep > 0) {
    lines.push(
      `距离睡眠窗口还有 ${formatMinutes(i.minutesToSleep)}` +
        (i.remainingPlannedMin ? `，期间还排了 ${formatMinutes(i.remainingPlannedMin)} 的计划` : '')
    )
  } else {
    lines.push('已经在睡眠窗口里了')
  }
  return lines
}
