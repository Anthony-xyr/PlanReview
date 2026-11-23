import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacWorkspaces } from './macWorkspaces'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', originalPlatform)
})

const fakeWindow = () => ({ setAlwaysOnTop: vi.fn(), setVisibleOnAllWorkspaces: vi.fn() })

function fakeDock(initial = true) {
  let visible = initial
  return {
    isVisible: vi.fn(() => visible),
    hide: vi.fn(() => { visible = false }),
    show: vi.fn(async () => { visible = true })
  }
}

it('applies the full-screen exception per window and restores the Dock after the last one ends', () => {
  const dock = fakeDock()
  const workspace = new MacWorkspaces(() => dock)
  const timer = fakeWindow()
  const float = fakeWindow()

  workspace.update(float, false)
  expect(float.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  workspace.update(float, true)
  workspace.update(float, true)
  expect(float.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver')
  expect(float.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(2)
  workspace.update(timer, true)
  expect(dock.hide).toHaveBeenCalledTimes(1)

  workspace.update(float, false)
  expect(float.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating')
  expect(float.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  vi.advanceTimersByTime(500)
  expect(dock.show).not.toHaveBeenCalled()
  workspace.forget(timer)
  vi.advanceTimersByTime(500)
  expect(dock.show).toHaveBeenCalledTimes(1)
})

it('keeps the Dock mode through a timer-to-picker handoff and honors the native re-hide cooldown', () => {
  const dock = fakeDock()
  const workspace = new MacWorkspaces(() => dock)
  const timer = fakeWindow()
  const float = fakeWindow()

  workspace.update(timer, true)
  workspace.update(timer, false)
  workspace.update(float, true)
  vi.advanceTimersByTime(400)
  expect(dock.show).not.toHaveBeenCalled()
  workspace.update(float, false)
  vi.advanceTimersByTime(250)
  expect(dock.show).toHaveBeenCalledTimes(1)
  workspace.update(float, true)
  vi.advanceTimersByTime(1000)
  expect(dock.hide).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(100)
  expect(dock.hide).toHaveBeenCalledTimes(2)
})

it('does not restore a Dock the app did not hide', () => {
  const dock = fakeDock(false)
  const workspace = new MacWorkspaces(() => dock)
  const float = fakeWindow()
  workspace.update(float, true)
  workspace.forget(float)
  vi.advanceTimersByTime(500)
  expect(dock.hide).not.toHaveBeenCalled()
  expect(dock.show).not.toHaveBeenCalled()
})
