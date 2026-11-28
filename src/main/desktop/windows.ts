import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, screen, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { MainCommand, Reminder, Settings, TimeEntry } from '@shared/types'
import { IPC_EVENTS } from '@shared/ipc'
import { desktopVisibility, floatIntentAfterReminder, floatIntentAfterTimerChange, floatMayCoverMacFullscreen, type FloatIntent } from '../desktopWindows'
import { MacWorkspaces } from '../macWorkspaces'
import { mainWindowChrome, updateMainWindowChrome } from '../mainWindowChrome'
import { TimerWindow } from '../timerWindow'
import { updateConfirmationNavigation } from '../update/restart'

const FLOAT_WIDTH = 320
const isMac = process.platform === 'darwin'

// 打包后 resources/ 解压在 app.asar.unpacked 里，托盘和系统通知能直接读到图标文件
export function resourcePath(name: string): string {
  return join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', name)
}

async function waitForDevServer(url: string, maxRetries = 30): Promise<boolean> {
  const http = await import('node:http')
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume()
          resolve()
        })
        req.on('error', reject)
        req.setTimeout(1000, () => {
          req.destroy()
          reject(new Error('timeout'))
        })
      })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return false
}

async function loadRenderer(win: BrowserWindow, hash = ''): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL + hash
    const ready = await waitForDevServer(process.env.ELECTRON_RENDERER_URL)
    if (!ready) console.warn('Dev server not ready after 6s, loading anyway...')
    await win.loadURL(url)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') })
  }
}

export interface DesktopWindowDeps {
  getSettings(): Settings
  getRunning(): TimeEntry | null
  getReminder(): Reminder | null
  isQuitting(): boolean
  hasInstalledUpdate(): boolean
  onInvalidateUpdateConfirmation(): void
  onFloatStateChanged(): void
}

/** 统一管理主窗口、悬浮窗、顶部计时器窗口及窗口间广播 */
export class DesktopWindows {
  private mainWin: BrowserWindow | null = null
  private floatWin: BrowserWindow | null = null
  private floatIntent: FloatIntent = 'auto'
  private floatReady = false
  private floatBridgeReady = false
  /** macOS 原生全屏 Space 的临时覆盖层，状态与普通悬浮窗分别维护 */
  private floatOverlay: BrowserWindow | null = null
  private overlayReady = false
  private overlayBridgeReady = false
  /** 本次显示需求内失败后只回退，避免每15秒重建坏窗口 */
  private overlayFailed = false
  private focusCaptureWhenReady = false
  private lastRunningId: string | null = null
  private fullscreenNow = false
  private readonly macWorkspaces = new MacWorkspaces(() => app.dock)
  readonly timer: TimerWindow

  constructor(private readonly deps: DesktopWindowDeps) {
    this.timer = new TimerWindow(
      () => ({ ...this.webPreferences(), additionalArguments: ['--planreview-timer'] }),
      loadRenderer,
      this.macWorkspaces
    )
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  }

  private allWindows(): BrowserWindow[] {
    return [this.mainWin, this.floatWin, this.floatOverlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
  }

  mainContents(): WebContents | undefined {
    return this.mainWin && !this.mainWin.isDestroyed() ? this.mainWin.webContents : undefined
  }

  isTimerSender(sender: WebContents): boolean {
    return this.timer.owns(sender)
  }

  isFloatMainFrame(event: IpcMainInvokeEvent): boolean {
    return !!event.senderFrame && event.senderFrame === event.sender.mainFrame &&
      [this.floatWin, this.floatOverlay].some((win) => !!win && !win.isDestroyed() && win.webContents === event.sender)
  }

  isFloatVisible(): boolean {
    return Boolean(this.floatWin && !this.floatWin.isDestroyed() && this.floatWin.isVisible())
  }

  isFloatExpectedVisible(settings: Settings, hasRunning: boolean, reminder: Reminder | null): boolean {
    return desktopVisibility(settings, hasRunning, this.fullscreenNow, this.floatIntent, reminder).float
  }

  watchTheme(): void {
    // 跟随系统时，系统切换深浅色后主窗口底色也跟着换
    nativeTheme.on('updated', () => this.syncMainWindowTheme())
  }

  syncMainWindowTheme(): void {
    const win = this.mainWin
    if (!win || win.isDestroyed()) return
    updateMainWindowChrome(win, nativeTheme.shouldUseDarkColors)
  }

  createMainWindow(): void {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 520,
      title: '计划与复盘',
      icon: resourcePath('icon.png'),
      ...mainWindowChrome(nativeTheme.shouldUseDarkColors),
      autoHideMenuBar: true,
      show: false,
      webPreferences: this.webPreferences()
    })
    this.mainWin = win
    win.once('ready-to-show', () => {
      // 开机自启：Windows 传 --hidden；macOS 不支持启动参数，用系统给的 wasOpenedAtLogin 判断
      const atLogin = isMac && app.getLoginItemSettings().wasOpenedAtLogin
      if (this.deps.hasInstalledUpdate() || (!process.argv.includes('--hidden') && !atLogin)) win.show()
    })
    // 外部链接交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url)
      return { action: 'deny' }
    })
    // 关闭主窗口时默认缩到托盘，悬浮窗和提醒继续工作
    win.on('close', (e) => {
      if (!this.deps.isQuitting() && this.deps.getSettings().closeToTray) {
        e.preventDefault()
        win.hide()
      }
    })
    const invalidate = () => this.deps.onInvalidateUpdateConfirmation()
    win.webContents.on('did-start-navigation', updateConfirmationNavigation(invalidate))
    win.webContents.on('render-process-gone', invalidate)
    win.on('hide', invalidate)
    win.on('closed', () => {
      this.mainWin = null
      invalidate()
    })
    void loadRenderer(win)
  }

  showMain(): void {
    if (this.deps.isQuitting()) return
    if (!this.mainWin || this.mainWin.isDestroyed()) this.createMainWindow()
    if (this.mainWin!.isMinimized()) this.mainWin!.restore()
    this.mainWin!.show()
    this.mainWin!.focus()
  }

  sendCommand(cmd: MainCommand): void {
    this.showMain()
    const send = () => this.mainWin?.webContents.send(IPC_EVENTS.command, cmd)
    if (this.mainWin?.webContents.isLoading()) this.mainWin.webContents.once('did-finish-load', send)
    else send()
  }

  broadcastDataChanged(from?: WebContents): void {
    for (const w of this.allWindows()) if (w.webContents !== from) w.webContents.send(IPC_EVENTS.dataChanged)
  }

  broadcastReminder(reminder: Reminder | null): void {
    for (const w of this.allWindows()) w.webContents.send(IPC_EVENTS.reminder, reminder)
  }

  setFullscreen(full: boolean): void {
    if (full === this.fullscreenNow) return
    this.fullscreenNow = full
    if (full && this.floatIntent === 'show') this.floatIntent = 'auto'
  }

  applyReminderIntent(reminder: Reminder | null): void {
    this.floatIntent = floatIntentAfterReminder(this.floatIntent, reminder)
  }

  resetFloatIntent(): void {
    this.floatIntent = 'auto'
    this.focusCaptureWhenReady = false
  }

  updateVisibility(
    s = this.deps.getSettings(),
    running = this.deps.getRunning(),
    reminder = this.deps.getReminder()
  ): void {
    if (this.deps.isQuitting()) return
    const runningId = running?.id ?? null
    if (runningId !== this.lastRunningId) this.focusCaptureWhenReady = false
    this.floatIntent = floatIntentAfterTimerChange(this.floatIntent, this.lastRunningId, runningId)
    this.lastRunningId = runningId
    const visible = desktopVisibility(s, running !== null, this.fullscreenNow, this.floatIntent, reminder)
    this.timer.update(running, visible.timer, s.hideInFullscreen)

    const coverFullscreen = isMac && floatMayCoverMacFullscreen(visible.float, s.hideInFullscreen, this.floatIntent, reminder)
    if (coverFullscreen && !this.overlayFailed) {
      if (!this.floatOverlay || this.floatOverlay.isDestroyed()) this.createFloatOverlay()
      if (this.floatOverlay && this.overlayReady && !this.floatOverlay.isVisible()) this.floatOverlay.showInactive()
      // 覆盖层和普通悬浮窗不能同时显示，否则桌面会出现两个同样的卡片
      this.floatWin?.hide()
      if (this.floatWin && this.floatReady) this.macWorkspaces.update(this.floatWin, false)
    } else if (coverFullscreen) {
      // 覆盖层失败：保留普通悬浮窗作为回退，不再反复重建覆盖层。
      if (this.floatWin && this.floatReady && !this.floatWin.isVisible() && this.floatIntent !== 'hide') this.floatWin.showInactive()
      if (this.floatWin && this.floatReady) this.macWorkspaces.update(this.floatWin, false)
    } else {
      this.destroyFloatOverlay()
      if (this.floatWin && this.floatReady) this.macWorkspaces.update(this.floatWin, false)
    }
    if (!visible.float) {
      this.destroyFloatOverlay()
      if (!s.floatingEnabled) this.floatWin?.destroy()
      else this.floatWin?.hide()
    } else if (!this.floatWin) {
      this.createFloatWindow()
    } else if (this.floatReady) {
      // 覆盖层正在显示时不能把普通窗口再 show 回来，否则又是两个卡片
      if (!coverFullscreen && !this.floatWin.isVisible()) this.floatWin.showInactive()
      this.focusCapture()
    }
  }

  revealFloat(capture = false): void {
    this.floatIntent = 'show'
    this.focusCaptureWhenReady = capture
    this.updateVisibility()
    this.deps.onFloatStateChanged()
  }

  concealFloat(): void {
    this.floatIntent = 'hide'
    this.focusCaptureWhenReady = false
    this.updateVisibility()
    this.deps.onFloatStateChanged()
  }

  private floatSurface(event: IpcMainInvokeEvent): BrowserWindow {
    if (!this.isFloatMainFrame(event)) throw new Error('仅悬浮窗主帧可使用此通道')
    return [this.floatWin, this.floatOverlay].find((win) => !!win && !win.isDestroyed() && win.webContents === event.sender)!
  }

  markFloatReady(event: IpcMainInvokeEvent): void {
    const win = this.floatSurface(event)
    if (win === this.floatOverlay) this.overlayBridgeReady = true
    else this.floatBridgeReady = true
    this.focusCapture()
  }

  resizeFloat(event: IpcMainInvokeEvent, height: number): void {
    const win = this.floatSurface(event)
    if (!Number.isFinite(height)) return
    const [w] = win.getSize()
    const h = Math.max(60, Math.min(600, Math.round(height)))
    const b = win.getBounds()
    if (b.height === h) return
    // 保留Windows透明窗缩小时的setBounds处理，不改窗口位置或宽度。
    win.setMinimumSize(w, 60)
    win.setBounds({ x: b.x, y: b.y, width: w, height: h })
  }

  dispose(): void {
    this.timer.dispose()
    this.destroyFloatOverlay()
  }

  private createFloatWindow(): void {
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      width: FLOAT_WIDTH,
      height: 120,
      x: area.x + area.width - FLOAT_WIDTH - 16,
      y: area.y + 16,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: '计划与复盘 · 悬浮窗',
      webPreferences: this.webPreferences()
    })
    this.floatWin = win
    win.setAlwaysOnTop(true, 'floating')
    win.webContents.on('did-start-loading', () => { this.floatBridgeReady = false })
    win.webContents.once('render-process-gone', () => win.destroy())
    win.once('closed', () => {
      this.floatWin = null
      this.floatReady = false
      this.floatBridgeReady = false
      this.macWorkspaces.forget(win)
    })
    win.once('ready-to-show', () => {
      this.floatReady = true
      this.updateVisibility()
    })
    void loadRenderer(win, '#float').catch((err: unknown) => {
      if (win.isDestroyed()) return
      console.error('Failed to load the floating window', err)
      win.destroy()
    })
  }

  private createFloatOverlay(): void {
    if (!isMac || (this.floatOverlay && !this.floatOverlay.isDestroyed())) return
    const b = this.floatWin && !this.floatWin.isDestroyed()
      ? this.floatWin.getBounds()
      : (() => {
          const area = screen.getPrimaryDisplay().workArea
          return { x: area.x + area.width - FLOAT_WIDTH - 16, y: area.y + 16, width: FLOAT_WIDTH, height: 260 }
        })()
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: FLOAT_WIDTH,
      height: b.height,
      frame: false,
      type: 'panel',
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: '计划与复盘 · 全屏悬浮窗',
      webPreferences: this.webPreferences()
    })
    this.floatOverlay = win
    this.overlayReady = false
    this.overlayBridgeReady = false
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.webContents.on('did-start-loading', () => { this.overlayBridgeReady = false })
    const fallBack = () => {
      // 过期加载回调不得影响后续新建的覆盖层或用户已经隐藏的窗口。
      if (this.floatOverlay !== win || win.isDestroyed()) return
      this.overlayFailed = true
      win.destroy()
      this.updateVisibility()
    }
    win.webContents.once('render-process-gone', fallBack)
    win.once('closed', () => {
      if (this.floatOverlay !== win) return
      this.floatOverlay = null
      this.overlayReady = false
      this.overlayBridgeReady = false
    })
    win.once('ready-to-show', () => {
      if (this.floatOverlay !== win || win.isDestroyed()) return
      this.overlayReady = true
      // 加载期间可能已经隐藏或切换任务，重新判断可见性，避免迟到的回调弹出第二张卡片。
      this.updateVisibility()
    })
    void loadRenderer(win, '#float').catch((err: unknown) => {
      if (this.floatOverlay !== win || win.isDestroyed()) return
      console.error('Failed to load the fullscreen float overlay', err)
      fallBack()
    })
  }

  private destroyFloatOverlay(): void {
    const win = this.floatOverlay
    this.floatOverlay = null
    this.overlayReady = false
    this.overlayBridgeReady = false
    this.overlayFailed = false
    win?.destroy()
  }


  private focusCapture(): void {
    const surface = this.floatOverlay && this.overlayReady && !this.floatOverlay.isDestroyed() ? this.floatOverlay : this.floatWin
    const bridge = surface === this.floatOverlay ? this.overlayBridgeReady : this.floatBridgeReady
    if (!this.focusCaptureWhenReady || !surface || !bridge || !surface.isVisible()) return
    this.focusCaptureWhenReady = false
    surface.show()
    surface.focus()
    surface.webContents.send(IPC_EVENTS.focusCapture)
  }
}
