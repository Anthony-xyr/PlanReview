import type { Reminder, Settings } from '@shared/types'

export type FloatIntent = 'auto' | 'show' | 'hide'

export function floatIntentAfterTimerChange(intent: FloatIntent, before: string | null, after: string | null): FloatIntent {
  return before === after ? intent : 'auto'
}

export function floatIntentAfterReminder(intent: FloatIntent, reminder: Pick<Reminder, 'kind' | 'fresh' | 'strong'> | null): FloatIntent {
  return intent === 'hide' && reminder?.fresh && (reminder.strong || reminder.kind === 'session-end') ? 'auto' : intent
}

export function floatMayCoverMacFullscreen(
  visible: boolean, hideInFullscreen: boolean, intent: FloatIntent, reminder: Pick<Reminder, 'strong'> | null
): boolean {
  return visible && (!hideInFullscreen || intent === 'show' || reminder?.strong === true)
}

export function desktopVisibility(
  settings: Pick<Settings, 'floatingEnabled' | 'hideInFullscreen'>,
  running: boolean,
  fullscreen: boolean,
  intent: FloatIntent,
  reminder: Pick<Reminder, 'kind' | 'strong'> | null
) {
  const hideForFullscreen = settings.hideInFullscreen && fullscreen
  const hasTimerReminder = reminder?.kind === 'session-end'
  const autoFloat = settings.floatingEnabled && (reminder?.strong || (!hideForFullscreen && (!running || hasTimerReminder)))
  return {
    float: intent === 'show' || (intent === 'auto' && autoFloat),
    timer: running && !hideForFullscreen
  }
}

export const TIMER_HEIGHT = 38
export const TIMER_INITIAL_WIDTH = 240
export const TIMER_CURSOR_POLL_MS = 50

type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }

export function timerMaxWidth(area: Rect): number {
  return Math.max(1, Math.min(540, area.width - 16))
}

export function timerBounds(area: Rect, requestedWidth: number): Rect {
  const width = Math.max(1, Math.min(timerMaxWidth(area), Math.ceil(requestedWidth)))
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + 8, width, height: TIMER_HEIGHT }
}

export function cursorNearTimer(point: Point, rect: Rect, wasNear: boolean): boolean {
  // 进入和离开用不同边距，光标沿边缘移动时不会反复淡入淡出。
  const margin = wasNear ? 24 : 16
  return point.x >= rect.x - margin && point.x < rect.x + rect.width + margin &&
    point.y >= rect.y - margin && point.y < rect.y + rect.height + margin
}
