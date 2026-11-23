import { BrowserWindow, screen } from 'electron'
import type { TimeEntry, TimerOverlayState } from '@shared/types'
import { cursorNearTimer, TIMER_INITIAL_WIDTH, timerBounds, timerMaxWidth } from './desktopWindows'

export class TimerWindow {
  private win: BrowserWindow | null = null
  private ready = false
  private visible = false
  private hideInFullscreen = true
  private width = TIMER_INITIAL_WIDTH
  private entry: TimerOverlayState['entry'] = null
  private hovered = false
  private hoverInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private preferences: () => Electron.WebPreferences,
    private load: (win: BrowserWindow, hash: string) => Promise<void>
  ) {}

  owns(sender: Electron.WebContents): boolean {
    return this.win?.webContents === sender
  }

  accepts(event: Electron.IpcMainInvokeEvent): boolean {
    return this.owns(event.sender) && event.senderFrame === event.sender.mainFrame
  }

  snapshot(): TimerOverlayState {
    return { entry: this.entry, maxWidth: timerMaxWidth(screen.getPrimaryDisplay().workArea), hovered: this.hovered }
  }

  update(running: TimeEntry | null, visible: boolean, hideInFullscreen: boolean): void {
    const entry = running ? { id: running.id, title: running.title, startAt: running.startAt, targetEndAt: running.targetEndAt } : null
    const changed = entry?.id !== this.entry?.id || entry?.title !== this.entry?.title ||
      entry?.startAt !== this.entry?.startAt || entry?.targetEndAt !== this.entry?.targetEndAt
    const fullscreenPolicyChanged = hideInFullscreen !== this.hideInFullscreen
    this.entry = entry
    this.visible = visible && entry !== null
    this.hideInFullscreen = hideInFullscreen
    if (!this.win && this.visible) this.create()
    else if (fullscreenPolicyChanged && this.win) this.applyFullscreenPolicy(this.win)
    if (changed) this.sendState()
    this.syncVisibility()
  }

  resize(width: number): void {
    if (!Number.isFinite(width) || width <= 0) return
    this.width = Math.min(540, Math.ceil(width))
    this.position()
  }

  dispose(): void {
    this.visible = false
    this.win?.destroy()
  }

  private create(): void {
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      ...timerBounds(area, this.width),
      title: '计划与复盘 · 本次计时',
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      movable: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: this.preferences()
    })
    this.win = win
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.applyFullscreenPolicy(win)
    win.setIgnoreMouseEvents(true)
    screen.on('display-metrics-changed', this.displayChanged)
    screen.on('display-added', this.displayChanged)
    screen.on('display-removed', this.displayChanged)
    win.once('ready-to-show', () => {
      this.ready = true
      this.sendState()
      this.syncVisibility()
    })
    win.on('show', () => this.pollCursor())
    win.on('hide', () => this.stopPolling())
    win.webContents.once('render-process-gone', () => win.destroy())
    win.once('closed', () => {
      this.stopPolling()
      this.win = null
      this.ready = false
      screen.removeListener('display-metrics-changed', this.displayChanged)
      screen.removeListener('display-added', this.displayChanged)
      screen.removeListener('display-removed', this.displayChanged)
    })
    void this.load(win, '#timer').catch((err: unknown) => {
      if (win.isDestroyed()) return
      console.error('Failed to load the desktop timer', err)
      win.destroy()
    })
  }

  private applyFullscreenPolicy(win: BrowserWindow): void {
    const aboveMacFullscreen = process.platform === 'darwin' && !this.hideInFullscreen
    win.setAlwaysOnTop(true, aboveMacFullscreen ? 'screen-saver' : 'floating')
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: aboveMacFullscreen, skipTransformProcessType: true })
    }
  }

  private syncVisibility(): void {
    if (!this.win || !this.ready) return
    if (this.visible && !this.win.isVisible()) this.win.showInactive()
    else if (!this.visible && this.win.isVisible()) this.win.hide()
  }

  private readonly displayChanged = () => {
    this.position()
    this.sendState()
  }

  private sendState(): void {
    if (this.ready) this.win?.webContents.send('timer-state', this.snapshot())
  }

  private position(): void {
    if (!this.win) return
    const current = this.win.getBounds()
    const next = timerBounds(screen.getPrimaryDisplay().workArea, this.width)
    if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) {
      this.win.setBounds(next)
    }
  }

  private setHovered(hovered: boolean): void {
    if (hovered === this.hovered) return
    this.hovered = hovered
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('timer-hover', hovered)
  }

  private pollCursor(): void {
    if (this.hoverInterval) return
    const check = () => {
      if (this.win?.isVisible()) this.setHovered(cursorNearTimer(screen.getCursorScreenPoint(), this.win.getBounds()))
    }
    check()
    this.hoverInterval = setInterval(check, 100)
  }

  private stopPolling(): void {
    if (this.hoverInterval) clearInterval(this.hoverInterval)
    this.hoverInterval = null
    this.setHovered(false)
  }
}
