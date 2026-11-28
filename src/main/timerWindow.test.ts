import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTimeEntry } from '@shared/testFactories'
import { TimerWindow } from './timerWindow'
import { MacWorkspaces } from './macWorkspaces'

vi.mock('electron', () => {
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 300 }))
  })
  return {
    screen,
    BrowserWindow: class extends EventEmitter {
      private visible = false
      private destroyed = false
      private bounds: Electron.Rectangle
      webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn(), mainFrame: {} })
      setAlwaysOnTop = vi.fn()
      setVisibleOnAllWorkspaces = vi.fn()
      setIgnoreMouseEvents = vi.fn()

      constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
        super()
        const { x = 0, y = 0, width = 0, height = 0 } = options
        this.bounds = { x, y, width, height }
      }
      getBounds() { return this.bounds }
      setBounds(bounds: Electron.Rectangle) { this.bounds = bounds }
      isVisible() { return this.visible }
      isDestroyed() { return this.destroyed }
      showInactive() { this.visible = true; this.emit('show') }
      hide() { this.visible = false; this.emit('hide') }
      destroy() { this.destroyed = true; this.emit('closed') }
    }
  }
})

const entry = makeTimeEntry({
  id: 'entry',
  title: 'Item',
  startAt: '2026-11-02T00:00:00.000Z'
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', originalPlatform)
})

it('仅可见时轮询，推送靠近状态，隐藏或销毁时停止并解绑屏幕事件', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  vi.useFakeTimers()
  const { screen } = await import('electron')
  const load = vi.fn(async (_win: Electron.BrowserWindow, _hash: string) => {})
  const controller = new TimerWindow(() => ({}), load, new MacWorkspaces(() => undefined))
  controller.update(entry, true, true)
  const [win, hash] = load.mock.calls[0]
  expect(hash).toBe('#timer')
  expect(win).toHaveProperty('options.focusable', false)
  expect(win).toHaveProperty('options.skipTaskbar', true)
  expect(win).toHaveProperty('options.hasShadow', false)
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
  expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()

  win.emit('ready-to-show')
  expect(win.isVisible()).toBe(true)
  vi.mocked(screen.getCursorScreenPoint).mockReturnValueOnce({ x: 600, y: 12 })
  await vi.advanceTimersByTimeAsync(50)
  expect(win.webContents.send).toHaveBeenCalledWith('timer-hover', true)
  await vi.advanceTimersByTimeAsync(50)
  expect(win.webContents.send).toHaveBeenCalledWith('timer-hover', false)

  controller.resize(300)
  expect(win.getBounds().x).toBe(450)
  vi.mocked(screen.getPrimaryDisplay).mockReturnValueOnce({ workArea: { x: -600, y: 20, width: 600, height: 500 } } as Electron.Display)
  screen.emit('display-metrics-changed')
  expect(win.getBounds()).toEqual({ x: -450, y: 28, width: 300, height: 38 })
  expect(controller.accepts({ sender: win.webContents, senderFrame: win.webContents.mainFrame } as Electron.IpcMainInvokeEvent)).toBe(true)
  expect(controller.accepts({ sender: win.webContents, senderFrame: null } as Electron.IpcMainInvokeEvent)).toBe(false)

  controller.update(null, false, true)
  expect(win.isVisible()).toBe(false)
  const pollCount = vi.mocked(screen.getCursorScreenPoint).mock.calls.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(pollCount)
  controller.update(entry, true, true)
  expect(vi.getTimerCount()).toBe(1)
  controller.dispose()
  expect(screen.listenerCount('display-metrics-changed')).toBe(0)
  expect(screen.listenerCount('display-added')).toBe(0)
  expect(screen.listenerCount('display-removed')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('creates a click-through timer on darwin using only Electron APIs and follows the Mac workspace setting', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  vi.useFakeTimers()
  const { screen } = await import('electron')
  const load = vi.fn(async (_win: Electron.BrowserWindow, _hash: string) => {})
  const controller = new TimerWindow(() => ({}), load, new MacWorkspaces(() => undefined))
  controller.update(entry, true, true)
  const [win, hash] = load.mock.calls[0]
  expect(hash).toBe('#timer')
  expect(win).toHaveProperty('options.frame', false)
  expect(win).toHaveProperty('options.transparent', true)
  expect(win).toHaveProperty('options.focusable', false)
  expect(win).not.toHaveProperty('options.titleBarOverlay')
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
  win.emit('ready-to-show')
  expect(win.isVisible()).toBe(true)
  expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  vi.mocked(screen.getCursorScreenPoint).mockReturnValueOnce({ x: 600, y: 12 })
  await vi.advanceTimersByTimeAsync(50)
  expect(win.webContents.send).toHaveBeenCalledWith('timer-hover', true)
  controller.update(entry, true, false)
  expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  controller.update(null, false, false)
  expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  expect(win.isVisible()).toBe(false)
  controller.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
