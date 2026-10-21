// 时间轴用到的纯函数：一天的范围、吸附、重叠分道。

export const SNAP_MIN = 15
export const MIN_MS = 60_000

/** 本地日期 'YYYY-MM-DD' */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 某个时刻属于哪一天：凌晨在 dayStartHour 之前算前一天 */
export function dayOf(d: Date, dayStartHour: number): string {
  return dateKey(new Date(d.getTime() - dayStartHour * 3_600_000))
}

/** 一天的起止：从当天 dayStartHour 点到次日同一时刻 */
export function dayRange(key: string, dayStartHour: number): { start: Date; end: Date } {
  const [y, m, d] = key.split('-').map(Number)
  const start = new Date(y, m - 1, d, dayStartHour)
  const end = new Date(y, m - 1, d + 1, dayStartHour)
  return { start, end }
}

export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + delta))
}

/** 从一天起点算的分钟数（可能跨过零点） */
export function minutesFrom(start: Date, t: Date | string): number {
  return (new Date(t).getTime() - start.getTime()) / MIN_MS
}

export function addMinutes(start: Date, min: number): Date {
  return new Date(start.getTime() + min * MIN_MS)
}

export function snap(min: number, step = SNAP_MIN): number {
  return Math.round(min / step) * step
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function hhmm(t: Date | string): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 'HH:MM' 转成这一天内的分钟偏移（早于起点的算到次日） */
export function clockToOffset(clock: string, dayStartHour: number): number {
  const [h, m] = clock.split(':').map(Number)
  const min = h * 60 + m - dayStartHour * 60
  return min < 0 ? min + 1440 : min
}

/** 区间 [a, b) 与 [c, d) 重叠的分钟数 */
export function overlapMin(a: number, b: number, c: number, d: number): number {
  return Math.max(0, Math.min(b, d) - Math.max(a, c))
}

export interface Lane {
  lane: number
  lanes: number
}

/**
 * 重叠分道：互相重叠的一组条目并排显示。
 * 返回与输入同序的分道信息。
 */
export function layoutLanes(items: { start: number; end: number }[]): Lane[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[b].end - items[a].end)
  const result: Lane[] = items.map(() => ({ lane: 0, lanes: 1 }))
  let cluster: number[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity

  const flush = () => {
    for (const i of cluster) result[i].lanes = laneEnds.length
    cluster = []
    laneEnds = []
  }

  for (const i of order) {
    const { start, end } = items[i]
    if (start >= clusterEnd) flush()
    let lane = laneEnds.findIndex((e) => e <= start)
    if (lane === -1) lane = laneEnds.push(end) - 1
    else laneEnds[lane] = end
    result[i].lane = lane
    cluster.push(i)
    clusterEnd = Math.max(clusterEnd === -Infinity ? end : clusterEnd, end)
  }
  flush()
  return result
}

/** 时长文字："1:05:09" 或 "12:30" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
