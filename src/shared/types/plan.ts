import type { TaskStatus } from './task'

/** 计划时段：关联任务，或是不关联任务的保留时段（如娱乐） */
export interface PlanBlock {
  id: string
  taskId: string | null
  /** 关联任务时为任务标题 */
  title: string
  categoryId: string | null
  taskStatus: TaskStatus | null
  startAt: string
  endAt: string
  /** 由课表生成的上课时段 */
  courseId: string | null
  location: string
}

export type EntrySource = 'timer' | 'manual'

export type OverrunReason = 'estimate' | 'scope' | 'interrupted' | 'record_error' | 'unknown'

export const OVERRUN_REASONS: { value: OverrunReason; label: string; hint: string }[] = [
  { value: 'estimate', label: '估时偏差', hint: '这件事本来就需要更久' },
  { value: 'scope', label: '范围扩大', hint: '做着做着多出了内容' },
  { value: 'interrupted', label: '受干扰', hint: '被打断或环境不好' },
  { value: 'record_error', label: '记录有误', hint: '忘了停表之类' },
  { value: 'unknown', label: '说不清', hint: '' }
]

/** 实际记录：计时或补录产生，与计划分开保存 */
export interface TimeEntry {
  id: string
  taskId: string | null
  title: string
  categoryId: string | null
  planBlockId: string | null
  startAt: string
  /** null 表示正在计时 */
  endAt: string | null
  source: EntrySource
  note: string
  /** 本次计划到几点结束；延长会推后它，但不改原计划 */
  targetEndAt: string | null
  /** 开始时定下的本次时长（分钟），用于判断超时 */
  plannedMin: number | null
  /** 累计延长了多少分钟 */
  extendedMin: number
  overrunReason: OverrunReason | null
}

export interface BlockInput {
  taskId?: string | null
  title?: string
  categoryId?: string | null
  startAt: string
  endAt: string
  location?: string
}

export interface EntryInput extends BlockInput {
  note?: string
}

export interface StartTimerInput {
  taskId?: string | null
  title?: string
  categoryId?: string | null
  planBlockId?: string | null
  /** 本次时长；不填时用计划块的结束时间或默认时长 */
  durationMin?: number | null
}

export interface StopTimerInput {
  nextStep?: string
  complete?: boolean
  overrunReason?: OverrunReason | null
}

export interface StopResult {
  entry: TimeEntry | null
  /** 不足 1 分钟的计时不保存 */
  discarded: boolean
}
