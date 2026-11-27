import type { OverrunReason } from './plan'
import type { DayMood } from './review'

// ---------- 周复盘 ----------

export interface WeekDay {
  day: string
  plannedMin: number
  actualMin: number
  /** 按大类的实际分钟数 */
  byCategory: Record<string, number>
  /** 落在睡眠窗口里的实际分钟数 */
  sleepWindowMin: number
  /** 当天最后一条记录结束的时刻（ISO），没有记录为 null */
  lastEndAt: string | null
  mood: DayMood | null
}

export interface WeekCategory {
  categoryId: string | null
  plannedMin: number
  actualMin: number
}

/** 估时偏差：本周完成的、有估时的任务，实际 / 估时 */
export interface EstimateRow {
  taskId: string
  title: string
  categoryId: string | null
  estimateMin: number
  spentMin: number
}

export interface WeekStats {
  weekStart: string
  days: WeekDay[]
  plannedMin: number
  actualMin: number
  /** 计划块里实际做了的比例（按分钟，0–1；没计划为 null） */
  fulfilment: number | null
  byCategory: WeekCategory[]
  estimates: EstimateRow[]
  /** 超时原因计数，含「未标注」 */
  reasons: { reason: OverrunReason | 'none'; count: number; minutes: number }[]
  /** 本周完成的任务数 / 新建的任务数 */
  completed: number
  created: number
  /** 范围扩大拆出的延伸任务数 */
  spinOffs: number
  /** 写了每日复盘的天数 */
  reviewedDays: number
}

/** 建议附带的改动；采纳后才执行 */
export type SuggestionAction =
  | { kind: 'none' }
  | { kind: 'setting'; key: 'defaultSessionMin' | 'extendStepMin' | 'leaveTime' | 'sleepStart' | 'sleepLeadMin'; value: number | string }
  | { kind: 'estimate'; taskId: string; estimateMin: number }
  | { kind: 'insight'; text: string }

export interface Suggestion {
  id: string
  title: string
  /** 依据：引用本周的具体数字或记录 */
  evidence: string
  action: SuggestionAction
  status: 'open' | 'applied' | 'dismissed'
}

export interface WeeklyReport {
  summary: string
  /** 做得好的 */
  wins: string[]
  /** 观察到的规律 */
  patterns: string[]
  suggestions: Suggestion[]
}

export interface ReviewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface WeeklyReview {
  weekStart: string
  report: WeeklyReport | null
  model: string
  messages: ReviewMessage[]
  createdAt: string
  updatedAt: string
}

// ---------- 个人画像 ----------

export type InsightStatus = 'pending' | 'accepted' | 'rejected'

/** AI 总结出的个人规律，确认后才会在之后的复盘里被引用 */
export interface Insight {
  id: string
  text: string
  evidence: string
  status: InsightStatus
  sourceWeek: string | null
  createdAt: string
  updatedAt: string
}
