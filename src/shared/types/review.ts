import type { PlanBlock, TimeEntry } from './plan'
import type { Task } from './task'

// ---------- 找回 ----------

/** 今天该回头看的事：到了下次查看日的、随机抽到的、收件箱积压情况 */
export interface Resurface {
  /** 下次查看日已到（含已过） */
  due: Task[]
  /** 今天随机抽到的未排期事项，同一天内固定 */
  picks: Task[]
  inbox: { count: number; oldestDays: number }
  /** 是否该提示整理：积压过多，或今天是每周整理日且收件箱不空 */
  tidyNeeded: boolean
  /** 今天已经整理过（关掉了提示） */
  tidyDismissed: boolean
  /** 昨天复盘时选的「今天先做」，已完成则为 null */
  firstThing: Task | null
  /** 昨天有计划或记录但还没复盘 */
  yesterdayUnreviewed: boolean
}

/** 找回卡片上的处理方式 */
export type ResurfaceAction =
  | { kind: 'keep' } // 移到待办
  | { kind: 'later'; days: number } // 改到几天后再看
  | { kind: 'clear' } // 去掉下次查看日，不再提醒
  | { kind: 'drop' } // 不做了

// ---------- 每日复盘 ----------

export type DayMood = 1 | 2 | 3 | 4 | 5

export interface DailyReview {
  /** 复盘的是哪一天（按一天的起点算） */
  day: string
  /** 整体感觉 1–5 */
  mood: DayMood | null
  /** 做得好的 / 想调整的，一两句 */
  note: string
  /** 明天最想先做的一件事 */
  tomorrowTaskId: string | null
  createdAt: string
  updatedAt: string
}

export interface DailyReviewInput {
  mood?: DayMood | null
  note?: string
  tomorrowTaskId?: string | null
}

/** 复盘页需要的当天数据，由主进程一次算好 */
export interface DaySummary {
  day: string
  plannedMin: number
  actualMin: number
  /** 按大类：计划 vs 实际 */
  byCategory: { categoryId: string | null; plannedMin: number; actualMin: number }[]
  /** 计划过但完全没动的块 */
  skipped: PlanBlock[]
  /** 没有计划、临时插入的实际记录 */
  unplanned: TimeEntry[]
  /** 超时但还没标原因的记录；plannedMin 是本次原定时长，补录的记录取对应计划块的长度 */
  needReason: { entry: TimeEntry; plannedMin: number }[]
  /** 今天完成的任务 */
  completed: Task[]
  review: DailyReview | null
}
