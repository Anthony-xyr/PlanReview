export const MAX_BACKGROUND_FILE_BYTES = 20 * 1024 * 1024
export const MAX_BACKGROUND_IMAGE_BYTES = 6 * 1024 * 1024
export const MAX_BACKGROUND_EDGE = 2560
export const BACKGROUND_IMAGE_PREFIX = 'data:image/webp;base64,'

export const DAY_BACKGROUND_SCHEDULE = [
  { startHour: 5, phase: 'dawn', label: '清晨' },
  { startHour: 9, phase: 'day', label: '白天' },
  { startHour: 17, phase: 'dusk', label: '黄昏' },
  { startHour: 20, phase: 'night', label: '夜间' }
] as const

export type DayBackground = (typeof DAY_BACKGROUND_SCHEDULE)[number]['phase']

export function dayBackground(now: Date): DayBackground {
  const hour = now.getHours()
  return DAY_BACKGROUND_SCHEDULE.findLast(({ startHour }) => hour >= startHour)?.phase ?? 'night'
}
