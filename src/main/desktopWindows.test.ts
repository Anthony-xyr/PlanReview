import { describe, expect, it } from 'vitest'
import { cursorNearTimer, desktopVisibility, floatIntentAfterReminder, floatIntentAfterTimerChange, timerBounds } from './desktopWindows'

const settings = { floatingEnabled: true, hideInFullscreen: true }

describe('悬浮窗与顶部计时器', () => {
  it('空闲显示悬浮窗，开始或切换时收起，停止后回到空闲', () => {
    expect(desktopVisibility(settings, false, false, 'auto', null)).toEqual({ float: true, timer: false })
    expect(desktopVisibility(settings, true, false, 'auto', null)).toEqual({ float: false, timer: true })
    expect(floatIntentAfterTimerChange('show', null, 'a')).toBe('auto')
    expect(floatIntentAfterTimerChange('show', 'a', 'b')).toBe('auto')
    expect(floatIntentAfterTimerChange('hide', 'b', null)).toBe('auto')
    expect(floatIntentAfterTimerChange('show', 'b', 'b')).toBe('show') // 延长保留主动唤出的悬浮窗
  })

  it('到点和强提醒可以显示悬浮窗，普通计划提醒仍走通知；主动唤出不依赖提醒', () => {
    expect(desktopVisibility(settings, true, false, 'auto', { kind: 'session-end', strong: false }).float).toBe(true)
    expect(desktopVisibility(settings, true, false, 'auto', { kind: 'block-start', strong: false }).float).toBe(false)
    expect(desktopVisibility(settings, true, false, 'show', null)).toEqual({ float: true, timer: true })
  })

  it('全屏设置挡住顶部计时器但不挡强提醒或主动唤出', () => {
    expect(desktopVisibility(settings, true, true, 'auto', null)).toEqual({ float: false, timer: false })
    expect(desktopVisibility(settings, true, true, 'auto', { kind: 'session-end', strong: false })).toEqual({ float: false, timer: false })
    expect(desktopVisibility(settings, true, true, 'auto', { kind: 'sleep', strong: true })).toEqual({ float: true, timer: false })
    expect(desktopVisibility(settings, true, true, 'show', null)).toEqual({ float: true, timer: false })
    expect(desktopVisibility({ ...settings, hideInFullscreen: false }, true, true, 'auto', null).timer).toBe(true)
  })

  it('关闭常驻悬浮窗不影响顶部，也不禁止主动唤出', () => {
    const disabled = { ...settings, floatingEnabled: false }
    expect(desktopVisibility(disabled, true, false, 'auto', null)).toEqual({ float: false, timer: true })
    expect(desktopVisibility(disabled, false, false, 'show', null)).toEqual({ float: true, timer: false })
  })

  it('新的到点或强提醒可重新显示，关闭已经显示过的提醒窗口后不会连着弹回', () => {
    expect(floatIntentAfterReminder('hide', { kind: 'sleep', fresh: true, strong: true })).toBe('auto')
    expect(floatIntentAfterReminder('hide', { kind: 'session-end', fresh: true, strong: false })).toBe('auto')
    expect(floatIntentAfterReminder('hide', { kind: 'session-end', fresh: false, strong: false })).toBe('hide')
    expect(floatIntentAfterReminder('hide', { kind: 'block-start', fresh: true, strong: false })).toBe('hide')
  })
})

describe('计时条几何', () => {
  const area = { x: -1280, y: 40, width: 1280, height: 720 }

  it('宽度随文字变化，在负坐标屏幕和小工作区也居中', () => {
    expect(timerBounds(area, 200)).toEqual({ x: -740, y: 48, width: 200, height: 34 })
    expect(timerBounds(area, 541)).toEqual({ x: -910, y: 48, width: 540, height: 34 })
    expect(timerBounds({ ...area, x: 300, width: 410 }, 540)).toEqual({ x: 308, y: 48, width: 394, height: 34 })
  })

  it('只在计时条及其外部小范围内判定为靠近', () => {
    const rect = timerBounds(area, 200)
    expect(cursorNearTimer({ x: rect.x - 12, y: rect.y }, rect)).toBe(true)
    expect(cursorNearTimer({ x: rect.x - 13, y: rect.y }, rect)).toBe(false)
    expect(cursorNearTimer({ x: rect.x + 10, y: rect.y + rect.height + 12 }, rect)).toBe(false)
  })
})
