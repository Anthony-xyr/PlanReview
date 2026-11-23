type WorkspaceWindow = Pick<Electron.BrowserWindow, 'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces'>
type Dock = Pick<Electron.Dock, 'isVisible' | 'hide' | 'show'>

const DOCK_RESTORE_DELAY_MS = 250
// Electron ignores Dock hide requests during the first second after a show.
const DOCK_HIDE_COOLDOWN_MS = 1100

/** Electron changes the application-wide Dock mode for fullscreen overlays. Coordinate that change across both windows. */
export class MacWorkspaces {
  private readonly modes = new WeakMap<WorkspaceWindow, boolean>()
  private readonly fullscreenWindows = new Set<WorkspaceWindow>()
  private restoreDock = false
  private lastDockShow = -Infinity
  private showTimer?: ReturnType<typeof setTimeout>
  private hideTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly dock: () => Dock | undefined) {}

  update(win: WorkspaceWindow, visibleOnFullScreen: boolean): void {
    if (process.platform !== 'darwin' || this.modes.get(win) === visibleOnFullScreen) return
    if (visibleOnFullScreen) {
      clearTimeout(this.showTimer)
      this.showTimer = undefined
      this.fullscreenWindows.add(win)
      if (this.fullscreenWindows.size === 1) this.hideDock()
    }
    // Change the shared Dock mode once, then apply the workspace flags to this window only.
    win.setAlwaysOnTop(true, visibleOnFullScreen ? 'screen-saver' : 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen, skipTransformProcessType: true })
    this.modes.set(win, visibleOnFullScreen)
    if (!visibleOnFullScreen) this.release(win)
  }

  forget(win: WorkspaceWindow): void {
    this.modes.delete(win)
    this.release(win)
  }

  private release(win: WorkspaceWindow): void {
    if (!this.fullscreenWindows.delete(win) || this.fullscreenWindows.size) return
    clearTimeout(this.hideTimer)
    this.hideTimer = undefined
    if (!this.restoreDock) return
    // Going from a running timer back to the picker can transfer the exception between windows.
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined
      this.restoreDock = false
      this.lastDockShow = performance.now()
      void this.dock()?.show().catch((err: unknown) => console.error('Failed to restore the Dock', err))
    }, DOCK_RESTORE_DELAY_MS)
  }

  private hideDock(): void {
    const dock = this.dock()
    if (this.restoreDock || !dock?.isVisible()) return
    const wait = Math.ceil(this.lastDockShow + DOCK_HIDE_COOLDOWN_MS - performance.now())
    if (wait > 0) {
      this.hideTimer = setTimeout(() => {
        this.hideTimer = undefined
        this.hideDock()
      }, wait)
      return
    }
    dock.hide()
    this.restoreDock = true
  }
}
