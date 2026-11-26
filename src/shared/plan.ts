import type { PlanBlock, TimeEntry } from './types'

const DAY_MS = 86_400_000

/** 计划块是否由课表生成（免计时占位，不计入计划兑现与跳过） */
export function isCourseBlock(block: Pick<PlanBlock, 'courseId'>): boolean {
  return block.courseId !== null
}

/** 计划块是否计入自主计划统计（兑现率、跳过计划、活跃周、计划提醒） */
export function countsTowardPlan(block: Pick<PlanBlock, 'courseId'>): boolean {
  return !isCourseBlock(block)
}

/** 计划块是否为不关联任务的自主保留时段（如娱乐、休息） */
export function isReservedBlock(block: Pick<PlanBlock, 'taskId' | 'courseId'>): boolean {
  return !block.taskId && countsTowardPlan(block)
}

/** 计划块是否可直接启动计时（排除课表及已完成/放弃的任务） */
export function isPlayableBlock(block: Pick<PlanBlock, 'courseId' | 'taskStatus'>): boolean {
  return countsTowardPlan(block) && block.taskStatus !== 'done' && block.taskStatus !== 'dropped'
}

/** 实际记录和计划块是否「对得上」：从该块开始计时、同一任务，或同名的自由时段 */
export function matchesBlockEntry(
  block: Pick<PlanBlock, 'id' | 'taskId' | 'title'>,
  entry: Pick<TimeEntry, 'planBlockId' | 'taskId' | 'title'>
): boolean {
  return entry.planBlockId === block.id || (block.taskId ? entry.taskId === block.taskId : !entry.taskId && entry.title === block.title)
}

/** 将 'HH:MM' 设置到 base 所在的本地日期上 */
export function withClock(base: Date | string, clock: string): Date {
  const d = new Date(base instanceof Date ? base.getTime() : base)
  const [h, m] = clock.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d
}

/** 将本地日期 'YYYY-MM-DD' 与 'HH:MM' 组合为 Date */
export function combineDateClock(day: string, clock: string): Date {
  const [y, mo, d] = day.split('-').map(Number)
  const [h, m] = clock.split(':').map(Number)
  return new Date(y, mo - 1, d, h, m, 0, 0)
}

/** 根据开始时刻与结束时钟计算结束时刻：结束早于等于开始时跨过零点，超过 24 小时则回拨一天 */
export function resolveEndAt(start: Date, baseEnd: Date | string, endClock: string): Date {
  let end = withClock(baseEnd, endClock)
  if (end <= start) end = new Date(end.getTime() + DAY_MS)
  if (end.getTime() - start.getTime() > DAY_MS) end = new Date(end.getTime() - DAY_MS)
  return end
}
