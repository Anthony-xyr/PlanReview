import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, globalShortcut, powerMonitor } from 'electron'

// 运行真实主进程入口和真实隔离数据库；只替换 Electron 窗口/系统边界，不会连接用户数据目录。
const state = vi.hoisted(() => ({
  root: '', windows: [] as Electron.BrowserWindow[], databases: [] as { close(): void }[],
  handlers: new Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  boot: undefined as (() => void) | undefined, rejectOverlayLoad: false
}))
vi.mock('node:sqlite', async (original) => {
  const sqlite = await original<typeof import('node:sqlite')>()
  return { ...sqlite, DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) { super(...args); state.databases.push(this) }
  } }
})
vi.mock('./native', () => ({ isFullscreenAppActive: vi.fn(() => false) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    private visible = false
    private destroyed = false
    private bounds: Electron.Rectangle
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: () => false,
      isDestroyed: () => this.destroyed
    })
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setMinimumSize = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setBackgroundColor = vi.fn()
    setTitleBarOverlay = vi.fn()
    focus = vi.fn()
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super()
      const { x = 0, y = 0, width = 0, height = 0 } = options
      this.bounds = { x, y, width, height }
      state.windows.push(this as unknown as Electron.BrowserWindow)
    }
    getBounds() { return this.bounds }
    setBounds(bounds: Electron.Rectangle) { this.bounds = bounds }
    getSize() { return [this.bounds.width, this.bounds.height] }
    isVisible() { return this.visible }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    showInactive() { if (this.destroyed) throw new Error('窗口已销毁'); this.visible = true; this.emit('show') }
    show() { this.showInactive() }
    hide() { this.visible = false; this.emit('hide') }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed') }
    async loadFile() { if (this.options.type === 'panel' && state.rejectOverlayLoad) throw new Error('覆盖层加载失败') }
    async loadURL() { return this.loadFile() }
  }
  class TestTray extends EventEmitter {
    setToolTip = vi.fn(); setImage = vi.fn(); setContextMenu = vi.fn(); setIgnoreDoubleClickEvents = vi.fn()
  }
  const dock = { setIcon: vi.fn(), isVisible: () => false, hide: vi.fn(), show: vi.fn(async () => {}) }
  return {
    BrowserWindow: Window, Tray: TestTray, powerMonitor: new EventEmitter(),
    app: Object.assign(new EventEmitter(), {
      isPackaged: false, dock, setPath: vi.fn(), getPath: (name: string) => name === 'appData' ? state.root : join(state.root, 'plan-review'),
      getAppPath: () => process.cwd(), getVersion: () => '0.3.0', getName: () => '隔离单元测试',
      requestSingleInstanceLock: () => true, quit: vi.fn(), setAppUserModelId: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }), setLoginItemSettings: vi.fn(),
      whenReady: () => ({ then: (boot: () => void) => { state.boot = boot } })
    }),
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
    ipcMain: { handle: (name: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => state.handlers.set(name, fn) },
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu: vi.fn() },
    nativeImage: { createFromPath: () => ({ setTemplateImage: vi.fn() }) },
    nativeTheme: Object.assign(new EventEmitter(), { themeSource: 'system', shouldUseDarkColors: false }),
    Notification: { isSupported: () => false },
    safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: vi.fn() },
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 400 })
    })
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function invoke(channel: string, win: Electron.BrowserWindow, args: unknown[] = [], subframe = false) {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error('未注册通道：' + channel)
  return handler({ sender: win.webContents, senderFrame: subframe ? {} : win.webContents.mainFrame } as Electron.IpcMainInvokeEvent, ...args)
}
const main = () => state.windows[0]
const float = () => state.windows.find(w => w !== main() && !w.isDestroyed() && !(w as unknown as { options: { type?: string } }).options.type)!
const overlays = () => state.windows.filter(w => (w as unknown as { options: { type?: string } }).options.type === 'panel')
function capture() {
  const callback = vi.mocked(globalShortcut.register).mock.calls.at(-1)?.[1]
  if (!callback) throw new Error('快捷键未注册')
  callback()
}
async function boot(platform: 'darwin' | 'win32' = 'darwin') {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
  await import('./index')
  state.boot!()
  main().emit('ready-to-show')
  float().emit('ready-to-show')
  invoke('win:floatReady', float())
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 28, 12))
  vi.stubGlobal('__dirname', resolve('src/main'))
  state.root = mkdtempSync(join(tmpdir(), 'planreview-overlay-test-'))
  mkdirSync(join(state.root, 'plan-review'))
  state.windows = []; state.databases = []; state.handlers.clear(); state.rejectOverlayLoad = false
  app.removeAllListeners()
})
afterEach(() => {
  app.emit('will-quit')
  expect(powerMonitor.listenerCount('resume')).toBe(0)
  for (const win of state.windows) win.destroy()
  for (const db of state.databases) db.close()
  // 只删除本测试创建的临时子目录，先核实解析后的路径仍在系统临时目录内。
  const rel = relative(resolve(tmpdir()), resolve(state.root))
  if (!rel.startsWith('planreview-overlay-test-') || rel.includes('..')) throw new Error('非法测试清理路径')
  rmSync(state.root, { recursive: true, force: true })
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('真实主进程的悬浮窗与覆盖层协作（Electron 边界替身，非 Mac 真机验证）', () => {
  it('普通桌面初始只有普通窗；主动唤出只显示覆盖层，隐藏后销毁并允许再次唤出', async () => {
    await boot()
    const ordinary = float()
    expect(overlays()).toHaveLength(0)
    expect(ordinary.isVisible()).toBe(true)
    capture()
    const overlay = overlays()[0]
    expect(ordinary.isVisible()).toBe(false)
    overlay.emit('ready-to-show')
    expect(overlay.focus).not.toHaveBeenCalled()
    invoke('win:floatReady', overlay)
    expect(overlay.isVisible()).toBe(true)
    expect(ordinary.isVisible()).toBe(false)
    expect(overlay.focus).toHaveBeenCalled()
    expect(overlay.webContents.send).toHaveBeenCalledWith('focus-capture')
    invoke('win:hideFloat', main())
    expect(overlay.isDestroyed()).toBe(true)
    expect(ordinary.isVisible()).toBe(false)
    invoke('win:showFloat', main())
    expect(overlays()).toHaveLength(2)
  })
  it('动态睡眠强提醒使用覆盖层，解除提醒后销毁并只恢复普通窗', async () => {
    await boot()
    invoke('settings:update', main(), [{ sleepStart: '12:00', sleepEnd: '13:00', sleepLeadMin: 0 }])
    expect(invoke('reminders:current', main())).toHaveProperty('strong', true)
    const overlay = overlays()[0]
    overlay.emit('ready-to-show')
    expect(overlay.isVisible()).toBe(true)
    expect(float().isVisible()).toBe(false)
    invoke('settings:update', main(), [{ sleepStart: '00:30', sleepEnd: '08:00', sleepLeadMin: 0 }])
    expect(overlay.isDestroyed()).toBe(true)
    expect(float().isVisible()).toBe(true)
  })
  it('覆盖层渲染崩溃立即回退普通窗，后续三轮提醒不反复重建，仍能聚焦速记', async () => {
    await boot()
    const ordinary = float()
    capture()
    const overlay = overlays()[0]
    overlay.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(overlay.isDestroyed()).toBe(true)
    expect(ordinary.isVisible()).toBe(true)
    expect(ordinary.webContents.send).toHaveBeenCalledWith('focus-capture')
    await vi.advanceTimersByTimeAsync(45_000)
    expect(overlays()).toHaveLength(1)
    expect(ordinary.isVisible()).toBe(true)
    invoke('win:hideFloat', main())
    invoke('win:showFloat', main())
    expect(overlays()).toHaveLength(2)
  })
  it('覆盖层加载失败立即回退，后续轮询不重建坏窗口', async () => {
    await boot()
    state.rejectOverlayLoad = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    capture()
    await Promise.resolve(); await Promise.resolve()
    expect(overlays()[0].isDestroyed()).toBe(true)
    expect(float().isVisible()).toBe(true)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(overlays()).toHaveLength(1)
  })
  it('主窗口、陌生窗口和子帧调用 floatReady/resizeFloat 都报错，合法覆盖层可以调整高度', async () => {
    await boot()
    capture()
    const overlay = overlays()[0]
    for (const channel of ['win:floatReady', 'win:resizeFloat']) {
      expect(() => invoke(channel, main(), [180])).toThrow('仅悬浮窗')
      expect(() => invoke(channel, float(), [180], true)).toThrow('仅悬浮窗')
      const stranger = { webContents: { mainFrame: {} } } as Electron.BrowserWindow
      expect(() => invoke(channel, stranger, [180])).toThrow('仅悬浮窗')
    }
    invoke('win:resizeFloat', overlay, [1000])
    expect(overlay.getBounds().height).toBe(600)
    invoke('win:resizeFloat', float(), [30])
    expect(float().getBounds().height).toBe(60)
  })
  it('窗口通道不广播数据改变，业务改变同时通知覆盖层和普通窗', async () => {
    await boot()
    capture()
    const overlay = overlays()[0]
    for (const win of state.windows) vi.mocked(win.webContents.send).mockClear()
    invoke('win:resizeFloat', overlay, [180])
    invoke('win:floatReady', overlay)
    for (const win of state.windows) expect(win.webContents.send).not.toHaveBeenCalledWith('data-changed')
    invoke('tasks:capture', main(), ['覆盖层广播回归'])
    expect(overlay.webContents.send).toHaveBeenCalledWith('data-changed')
    expect(float().webContents.send).toHaveBeenCalledWith('data-changed')
  })
  it('加载中用户隐藏后，迟到的 ready-to-show 不得重新弹窗', async () => {
    await boot()
    capture()
    const overlay = overlays()[0]
    invoke('win:hideFloat', main())
    expect(() => overlay.emit('ready-to-show')).not.toThrow()
    expect(overlay.isVisible()).toBe(false)
    expect(float().isVisible()).toBe(false)
  })
  it('关闭常驻且无强提醒后销毁覆盖层，普通窗与覆盖层都隐藏', async () => {
    await boot()
    invoke('settings:update', main(), [{ hideInFullscreen: false }])
    const overlay = overlays()[0]
    overlay.emit('ready-to-show')
    expect(overlay.isVisible()).toBe(true)
    invoke('settings:update', main(), [{ floatingEnabled: false }])
    expect(overlay.isDestroyed()).toBe(true)
    expect(state.windows.filter(w => w !== main() && w.isVisible())).toHaveLength(0)
  })
  it('Windows 保持普通悬浮窗和原焦点路径，不创建 panel 覆盖层', async () => {
    await boot('win32')
    const ordinary = float()
    capture()
    expect(overlays()).toHaveLength(0)
    expect(ordinary.isVisible()).toBe(true)
    expect(ordinary.focus).toHaveBeenCalled()
    expect(ordinary.webContents.send).toHaveBeenCalledWith('focus-capture')
    expect(ordinary.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true)
  })
  it('系统恢复只通知主窗口刷新背景，退出后释放监听器', async () => {
    await boot('win32')
    for (const win of state.windows) vi.mocked(win.webContents.send).mockClear()
    expect(powerMonitor.listenerCount('resume')).toBe(1)
    powerMonitor.emit('resume')
    expect(main().webContents.send).toHaveBeenCalledWith('system-resume')
    expect(float().webContents.send).not.toHaveBeenCalledWith('system-resume')
  })
})
