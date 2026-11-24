import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, ipcMain, nativeTheme, powerMonitor, safeStorage } from 'electron'
import { IPC_EVENTS } from '@shared/ipc'
import { migrate } from './db/schema'
import { Repo } from './db/repo'
import { TimeRepo } from './db/timeRepo'
import { CourseRepo } from './db/courseRepo'
import { ReviewRepo } from './db/reviewRepo'
import { WeeklyRepo } from './db/weeklyRepo'
import { HabitRepo } from './db/habitRepo'
import { AiConfigStore } from './ai/config'
import { AiService } from './ai/service'
import { ReminderCenter, reminderSnapshot } from './reminders'
import { isFullscreenAppActive } from './native'
import { registerAppIpc } from './ipc'
import { UpdateRuntime } from './update/runtime'
import { DesktopWindows, resourcePath } from './desktop/windows'
import { createAppMenu, DesktopTray, showReminderNotification } from './desktop/tray'
import { SystemSettingsApplier } from './desktop/settingsApplier'

const onResume = () => windows.mainContents()?.send(IPC_EVENTS.resume)

const TICK_MS = 15_000
const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

let quitting = false
let lastReminderSig: string | null = null
let tickInterval: ReturnType<typeof setInterval> | undefined
/** macOS 启动时（含开机自启）系统可能立刻发 activate，别让它把本来要隐藏的主窗口叫出来 */
let suppressActivateUntil = 0

let updates: UpdateRuntime | undefined
let time: TimeRepo
let center: ReminderCenter

const windows = new DesktopWindows({
  getSettings: () => time.getSettings(),
  getRunning: () => time.running(),
  getReminder: () => center.get(),
  isQuitting: () => quitting,
  hasInstalledUpdate: () => updates?.hasInstalledVersion() ?? false,
  onInvalidateUpdateConfirmation: () => updates?.invalidateConfirmation(),
  onFloatStateChanged: () => updateTray()
})

const tray = new DesktopTray({
  showMain: () => windows.showMain(),
  toggleCapture: () => windows.revealFloat(true),
  revealFloat: () => windows.revealFloat(),
  concealFloat: () => windows.concealFloat(),
  sendCommand: (cmd) => windows.sendCommand(cmd),
  requestUpdateRestart: () => updates?.requestTrayRestart()
})

const systemSettings = new SystemSettingsApplier(
  () => windows.revealFloat(true),
  () => windows.syncMainWindowTheme()
)

function openDatabase() {
  const db = new DatabaseSync(join(app.getPath('userData'), 'plan-review.db'))
  migrate(db)
  const repo = new Repo(db)
  time = new TimeRepo(db)
  center = new ReminderCenter(time, db)
  const courses = new CourseRepo(db)
  const review = new ReviewRepo(db, repo, time)
  const weekly = new WeeklyRepo(db, repo, time)
  const habits = new HabitRepo(db)
  const aiConfig = new AiConfigStore(db, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
  })
  const ai = new AiService({ repo, time, review, weekly, habits, aiConfig })
  return { db, repo, time, courses, review, weekly, habits, aiConfig, ai }
}

function updateTray(): void {
  if (quitting || !tray.hasTray()) return
  const running = time.running()
  const settings = time.getSettings()
  tray.update({
    running,
    settings,
    floatShown: windows.isFloatExpectedVisible(settings, running !== null, center.get()),
    readyUpdateVersion: updates?.readyVersion() ?? null
  })
}

function tick(): void {
  if (quitting) return
  const settings = time.getSettings()
  const snapshot = reminderSnapshot(time, new Date(), settings)
  const reminder = center.evaluate(snapshot)

  windows.setFullscreen(isWindows && settings.hideInFullscreen && isFullscreenAppActive() === true)

  // 内容变化就重新推送（比如同一个睡眠提醒，开始计时后文字要跟着变）
  const sig = reminder ? JSON.stringify({ ...reminder, fresh: undefined }) : null
  if (sig !== lastReminderSig) {
    lastReminderSig = sig
    windows.broadcastReminder(reminder)
  }
  windows.applyReminderIntent(reminder)
  windows.updateVisibility(settings, snapshot.running, reminder)
  if (reminder?.fresh) {
    showReminderNotification(reminder, settings, windows.isFloatVisible(), () =>
      time.getSettings().floatingEnabled ? windows.revealFloat() : windows.showMain()
    )
  }
  updateTray()
}

// ---------- 启动 ----------

// 开发版和安装版用同一个数据目录：Windows 在 %APPDATA%\plan-review，macOS 在
// ~/Library/Application Support/plan-review，装好后之前的数据还在。
// 要在 requestSingleInstanceLock 之前设，单实例锁也放在这个目录里
app.setPath('userData', join(app.getPath('appData'), 'plan-review'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => windows.showMain())

  app.whenReady().then(() => {
    if (isWindows) app.setAppUserModelId('plan-review')
    // 开发时 Dock 默认是 Electron 的图标，换成应用自己的；打包后由 .icns 决定
    if (isMac && !app.isPackaged) app.dock?.setIcon(resourcePath('icon.png'))
    if (process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin)) {
      suppressActivateUntil = Date.now() + 3000
    }

    createAppMenu(() => windows.showMain())
    const deps = openDatabase()

    updates = new UpdateRuntime({
      db: deps.db,
      running: () => time.running(),
      mainContents: () => windows.mainContents(),
      showMain: () => windows.showMain(),
      isQuitting: () => quitting,
      setQuitting: (v) => { quitting = v },
      onReadyVersionChanged: () => updateTray()
    })

    registerAppIpc(ipcMain, {
      ...deps,
      center,
      timer: windows.timer,
      guards: {
        isTimerSender: (sender) => windows.isTimerSender(sender),
        isFloatMainFrame: (event) => windows.isFloatMainFrame(event),
        onDataChanged: (sender) => {
          windows.broadcastDataChanged(sender)
          tick()
        }
      },
      updateSettings: (patch, backgroundImage) => {
        const previousFloatingEnabled = time.getSettings().floatingEnabled
        const s = time.updateSettings(patch, backgroundImage)
        if (s.floatingEnabled !== previousFloatingEnabled) windows.resetFloatIntent()
        systemSettings.apply(s)
        return s
      },
      openMain: (cmd) => (cmd ? windows.sendCommand(cmd) : windows.showMain()),
      showFloat: () => windows.revealFloat(),
      hideFloat: () => windows.concealFloat(),
      floatReady: (event) => windows.markFloatReady(event),
      resizeFloat: (event, height) => windows.resizeFloat(event, height),
      status: () => systemSettings.status()
    })

    const settings = time.getSettings()
    // 创建窗口前设置主题，让首帧、页面媒体查询和原生按钮颜色一致。
    nativeTheme.themeSource = settings.theme
    windows.createMainWindow()
    tray.create({
      running: time.running(),
      settings,
      floatShown: windows.isFloatExpectedVisible(settings, time.running() !== null, center.get()),
      readyUpdateVersion: updates.readyVersion()
    })
    windows.watchTheme()
    powerMonitor.on('resume', onResume)
    systemSettings.apply(settings)
    tick()
    tickInterval = setInterval(tick, TICK_MS)
    updates.start()
  })

  // macOS：点 Dock 图标时把主窗口叫回来（窗口被缩到托盘后也有效）
  if (isMac) {
    app.on('activate', () => {
      if (Date.now() < suppressActivateUntil) return
      windows.showMain()
    })
  }

  app.on('before-quit', () => {
    quitting = true
    updates?.invalidateConfirmation()
    updates?.saveBeforeExit()
  })
  app.on('will-quit', () => {
    powerMonitor.removeListener('resume', onResume)
    updates?.dispose()
    clearInterval(tickInterval)
    windows.dispose()
    systemSettings.dispose()
  })
  // 有托盘时关闭所有窗口也不退出
  app.on('window-all-closed', () => {
    if (!tray.hasTray()) app.quit()
  })
}
