import type { TimeEntry } from './plan'

export type ThemeMode = 'system' | 'light' | 'dark'
export type BackgroundMode = 'plain' | 'time' | 'custom'
export type BackgroundFit = 'cover' | 'contain'

export interface Settings {
  /** 一天从几点算起，之前的时间归前一天 */
  dayStartHour: number
  /** 睡眠窗口，'HH:MM' */
  sleepStart: string
  sleepEnd: string
  /** 从任务直接开始计时时的默认本次时长；null 表示不设 */
  defaultSessionMin: number | null
  extendStepMin: number
  /** 实际超过本次计划多少比例时询问原因 */
  overrunAskRatio: number
  /** 睡眠窗口前多少分钟开始强提醒 */
  sleepLeadMin: number
  leaveEnabled: boolean
  /** 自习室离开时间 */
  leaveTime: string
  leaveLeadMin: number
  /** 计划块开始 / 保留时段结束时提醒 */
  blockReminders: boolean
  /** 强提醒时播放提示音 */
  strongSound: boolean
  floatingEnabled: boolean
  hideInFullscreen: boolean
  hotkey: string
  closeToTray: boolean
  launchAtLogin: boolean
  /** 每日随机推送几条未排期事项，0 表示关闭 */
  dailyPicks: number
  /** 收件箱积压到多少条、或最旧一条放了多少天，提示整理 */
  inboxNagCount: number
  inboxNagDays: number
  /** 每周哪天提醒整理（0=周日 … 6=周六） */
  weeklyReviewDay: number
  /** 外观：跟随系统、浅色、深色 */
  theme: ThemeMode
  /** 主窗口背景，与深浅配色独立 */
  backgroundMode: BackgroundMode
  backgroundFit: BackgroundFit
  /** 自定义图片的不透明度，0–100 */
  backgroundOpacity: number
}

export type ReminderKind = 'session-end' | 'sleep-lead' | 'sleep' | 'leave' | 'block-start' | 'block-end'

/** 延长或继续下去会影响什么 */
export interface Impact {
  /** 会被挤占的后续计划 */
  squeezed: { title: string; startAt: string }[]
  /** 距离睡眠窗口还有多少分钟；已进入时为 0 */
  minutesToSleep: number
  /** 现在之后、睡眠窗口之前还没做的计划分钟数 */
  remainingPlannedMin: number
}

export interface Reminder {
  id: string
  kind: ReminderKind
  strong: boolean
  title: string
  body: string
  entryId?: string
  blockId?: string
  taskId?: string | null
  impact?: Impact
  /** 延长时会用到的步长 */
  extendMin?: number
  /** 第一次出现（用于决定是否响铃） */
  fresh: boolean
}

export type MainCommand = 'stop' | 'wrap-up' | 'today' | 'review' | 'weekly'

export interface SystemStatus {
  hotkeyRegistered: boolean
  /** Windows 上靠系统接口检测；macOS 由系统的全屏桌面（Space）天然隔离，不需要检测 */
  fullscreenDetection: boolean
  platform: 'win32' | 'darwin' | 'linux'
}

export interface TimerOverlayState {
  entry: Pick<TimeEntry, 'id' | 'title' | 'startAt' | 'targetEndAt'> | null
  maxWidth: number
  hovered: boolean
}
