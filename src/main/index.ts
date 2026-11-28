import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, Tray } from 'electron'
import type {
  AiConfigPatch,
  CaptureDraft,
  DailyReviewInput,
  ImportFile,
  MainCommand,
  Reminder,
  ResurfaceAction,
  InsightStatus,
  SuggestedBlock,
  ScheduleDraft,
  Settings,
  SystemStatus
} from '@shared/types'
import { dayRange } from '@shared/time'
import { hotkeyLabel } from '@shared/format'
import { migrate } from './db/schema'
import { Repo } from './db/repo'
import { TimeRepo, sleepWindow } from './db/timeRepo'
import { ReminderCenter, reminderSnapshot } from './reminders'
import { isFullscreenAppActive } from './native'
import { CourseRepo } from './db/courseRepo'
import { AiConfigStore } from './ai/config'
import { ReviewRepo } from './db/reviewRepo'
import { chat } from './ai/client'
import { parseCapture, reparseCapture } from './ai/capture'
import { HabitRepo } from './db/habitRepo'
import { parseSchedule } from './ai/schedule'
import { WeeklyRepo } from './db/weeklyRepo'
import { askWeekly, generateWeekly, weekContextText, type WeekContext } from './ai/weekly'
import { freeGaps, suggestPlan } from './ai/planner'
import { desktopVisibility, floatIntentAfterReminder, floatIntentAfterTimerChange, floatMayCoverMacFullscreen, type FloatIntent } from './desktopWindows'
import { MacWorkspaces } from './macWorkspaces'
import { mainWindowChrome, updateMainWindowChrome } from './mainWindowChrome'
import { TimerWindow } from './timerWindow'
import { UPDATE_IPC, type UpdateSnapshot } from '@shared/update'
import { macReleaseChecker, windowsUpdater } from './update/adapters'
import { snapshotBeforeUpdate } from './update/backup'
import { prepareUpdateExit } from './update/exit'
import { registerUpdateConfirmationIpc, registerUpdateIpc } from './update/ipc'
import { updaterLog } from './update/log'
import { UpdatePreferences } from './update/preferences'
import { UpdateRestart, updateConfirmationNavigation } from './update/restart'
import { UpdaterService, updateMode } from './update/service'

const FLOAT_WIDTH = 320
const TICK_MS = 15_000
const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

let database: DatabaseSync | undefined
let updates: UpdaterService | undefined
let updatePrefs: UpdatePreferences | undefined
let logUpdate = (_event: string): void => {}
let updateRestart: UpdateRestart | undefined
let exitSaved = false
let repo: Repo
let time: TimeRepo
let center: ReminderCenter
let courses: CourseRepo
let aiConfig: AiConfigStore
let review: ReviewRepo
let weekly: WeeklyRepo
let habits: HabitRepo
let mainWin: BrowserWindow | null = null
let floatWin: BrowserWindow | null = null
let tray: Tray | null = null
let trayUpdateVersion: string | null = null
let quitting = false
let hotkeyRegistered = false
let registeredHotkey = ''
let floatIntent: FloatIntent = 'auto'
let floatReady = false
let floatBridgeReady = false
/** macOS 全屏 Space 中临时承载悬浮内容的 NSPanel；普通窗口无法动态进入当前全屏 Space */
let floatOverlay: BrowserWindow | null = null
let overlayReady = false
let overlayBridgeReady = false
/** 覆盖层加载/渲染失败后先回退普通悬浮窗，避免每 15 秒重建一个坏窗口 */
let overlayFailed = false
let focusCaptureWhenReady = false
let lastRunningId: string | null = null
let fullscreenNow = false
let lastReminderSig: string | null = null
let tickInterval: ReturnType<typeof setInterval> | undefined
/** macOS 启动时（含开机自启）系统可能立刻发 activate，别让它把本来要隐藏的主窗口叫出来 */
let suppressActivateUntil = 0

// 打包后 resources/ 解压在 app.asar.unpacked 里，托盘和系统通知能直接读到图标文件
const resource = (name: string) => join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', name)

const trayIconCache = new Map<string, Electron.NativeImage>()
/** macOS 菜单栏用单色模板图（深浅色自动反色）；Windows 继续用带颜色的托盘图 */
function trayIcon(kind: 'idle' | 'running'): Electron.NativeImage {
  const file = isMac ? (kind === 'running' ? 'tray-running-template.png' : 'tray-template.png') : kind === 'running' ? 'tray-running.png' : 'tray.png'
  const cached = trayIconCache.get(file)
  if (cached) return cached
  const img = nativeImage.createFromPath(resource(file))
  if (isMac) img.setTemplateImage(true)
  trayIconCache.set(file, img)
  return img
}

function openDatabase(): void {
  const db = new DatabaseSync(join(app.getPath('userData'), 'plan-review.db'))
  migrate(db)
  database = db
  repo = new Repo(db)
  time = new TimeRepo(db)
  center = new ReminderCenter(time, db)
  courses = new CourseRepo(db)
  review = new ReviewRepo(db, repo, time)
  weekly = new WeeklyRepo(db, repo, time)
  habits = new HabitRepo(db)
  aiConfig = new AiConfigStore(db, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
  })
}

/** 测试连接：发一句最简单的话，看能不能拿到回复 */
/** 周复盘要给 AI 的全部材料：统计、每日复盘原话、待办估时、已确认的画像 */
function weekContext(weekStart: string): WeekContext {
  const notes = Array.from({ length: 7 }, (_, i) => {
    const [y, m, d] = weekStart.split('-').map(Number)
    const dt = new Date(y, m - 1, d + i)
    const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    const r = review.getReview(day)
    return { day, mood: r?.mood ?? null, note: r?.note ?? '' }
  })
  return {
    stats: weekly.stats(weekStart),
    notes,
    categories: repo.listCategories(),
    settings: time.getSettings(),
    openTasks: repo.listTasks({ status: ['inbox', 'active'] }),
    insights: weekly.acceptedInsights()
  }
}

async function generateWeeklyReview(weekStart: string) {
  const ep = aiConfig.endpoint()
  const { report, insights } = await generateWeekly(ep, weekContext(weekStart), aiConfig.effort('weeklyReview'))
  return weekly.saveReport(weekStart, report, ep.model, insights)
}

async function askWeeklyReview(weekStart: string, question: string) {
  const q = question.trim()
  if (!q) throw new Error('问题不能为空')
  if (q.length > 1000) throw new Error('问题太长了')
  const r = weekly.get(weekStart)
  if (!r?.report) throw new Error('先生成这一周的复盘')
  const answer = await askWeekly(aiConfig.endpoint(), weekContextText(weekContext(weekStart)), r.report, r.messages, q, aiConfig.effort('weeklyQA'))
  // 先拿到回答再写入，失败时不留半截对话
  weekly.addMessage(weekStart, 'user', q)
  return weekly.addMessage(weekStart, 'assistant', answer)
}

async function suggestDayPlan(day: string, hint: string) {
  const cfg = time.getSettings()
  const { start, end } = dayRange(day, cfg.dayStartHour)
  const now = new Date()
  const from = new Date(Math.max(now.getTime(), start.getTime()))
  if (from >= end) throw new Error('这一天已经过去了')
  // 排到睡眠窗口开始为止
  const sleep = sleepWindow(from, cfg)
  const until = new Date(Math.min(end.getTime(), sleep.inside ? from.getTime() : sleep.start.getTime()))
  const blocks = time.listBlocks(start.toISOString(), end.toISOString())
  const scheduled = new Set(blocks.filter((b) => new Date(b.endAt) > now).map((b) => b.taskId))
  return suggestPlan(
    aiConfig.endpoint(),
    {
      day,
      now: from,
      gaps: freeGaps(from, until, blocks),
      blocks,
      tasks: repo.listTasks({ status: ['inbox', 'active'] }).filter((t) => !scheduled.has(t.id)),
      categories: repo.listCategories(),
      insights: weekly.acceptedInsights(),
      hint
    },
    cfg.dayStartHour,
    aiConfig.effort('planner')
  )
}

/** 写入用户勾选的建议；逐条走正常的建块校验，有一条失败就整体回滚 */
function acceptDayPlan(blocks: SuggestedBlock[]): { created: number } {
  if (!Array.isArray(blocks) || blocks.length > 30) throw new Error('建议格式不对')
  const created: string[] = []
  try {
    for (const b of blocks) created.push(time.createBlock({ taskId: b.taskId, title: b.title, startAt: b.startAt, endAt: b.endAt }).id)
  } catch (e) {
    for (const id of created) time.deleteBlock(id)
    throw e
  }
  return { created: created.length }
}

async function testAi(): Promise<{ ok: true; model: string; ms: number }> {
  const ep = aiConfig.endpoint()
  const t = Date.now()
  await chat(ep, [{ role: 'user', content: '只回复两个字：好的' }], { timeoutMs: 20_000 })
  return { ok: true, model: ep.model, ms: Date.now() - t }
}

// ---------- 广播 ----------

function allWindows(): BrowserWindow[] {
  return [mainWin, floatWin, floatOverlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
}

/** 数据改变：通知所有窗口刷新，并立即重新计算提醒 */
function dataChanged(from?: Electron.WebContents): void {
  for (const w of allWindows()) if (w.webContents !== from) w.webContents.send('data-changed')
  tick()
}

function sendCommand(cmd: MainCommand): void {
  showMain()
  const send = () => mainWin?.webContents.send('command', cmd)
  if (mainWin?.webContents.isLoading()) mainWin.webContents.once('did-finish-load', send)
  else send()
}

// ---------- IPC ----------

// 只读通道不触发刷新
const READ_ONLY = new Set([
  'tasks:list', 'tasks:get', 'tasks:lineage', 'categories:list', 'tags:list', 'plan:list', 'plan:startedIds',
  'entries:list', 'entries:running', 'settings:get', 'reminders:current', 'win:status',
  'ai:getConfig', 'ai:test', 'ai:parseCapture', 'ai:reparseCapture', 'ai:parseSchedule', 'courses:list', 'habits:list',
  // 首次调用会定下当天的随机推送，但界面上没有可见变化
  'resurface:get', 'review:summary',
  'weekly:stats', 'weekly:activeWeeks', 'weekly:get', 'insights:list', 'planner:suggest'
])

function registerIpc(): void {
  const handlers: Record<string, (...args: never[]) => unknown> = {
    'tasks:list': (filter) => repo.listTasks(filter),
    'tasks:get': (id: string) => repo.getTask(id),
    'tasks:capture': (text: string, defaults) => repo.capture(text, defaults),
    'tasks:create': (input) => repo.createTask(input),
    'tasks:update': (id: string, patch) => repo.updateTask(id, patch),
    'tasks:remove': (id: string) => repo.deleteTask(id),
    'tasks:spinOff': (id: string, input) => repo.spinOff(id, input),
    'tasks:lineage': (id: string) => repo.lineage(id),
    'categories:list': () => repo.listCategories(),
    'categories:create': (name: string, color: string) => repo.createCategory(name, color),
    'categories:update': (id: string, patch) => repo.updateCategory(id, patch),
    'categories:remove': (id: string, moveOpenTo?: string | null) => repo.removeCategory(id, moveOpenTo),
    'categories:reorder': (ids: string[]) => repo.reorderCategories(ids),
    'categories:openCounts': () => repo.openCountByCategory(),
    'tags:list': () => repo.listTags(),
    'plan:list': (from: string, to: string) => time.listBlocks(from, to),
    'plan:startedIds': (from: string, to: string) => time.startedBlockIds(from, to),
    'plan:create': (input) => time.createBlock(input),
    'plan:copy': (id: string, startAt: string) => time.copyBlock(id, startAt),
    'plan:update': (id: string, patch) => time.updateBlock(id, patch),
    'plan:remove': (id: string) => time.deleteBlock(id),
    'entries:list': (from: string, to: string) => time.listEntries(from, to),
    'entries:create': (input) => time.createEntry(input),
    'entries:update': (id: string, patch) => time.updateEntry(id, patch),
    'entries:remove': (id: string) => time.deleteEntry(id),
    'entries:running': () => time.running(),
    'entries:start': (input) => time.start(input),
    'entries:stop': (input) => time.stop(input),
    'entries:extend': (min: number) => time.extend(min),
    'entries:setTarget': (endAt: string | null) => time.setTarget(endAt),
    'entries:setReason': (id: string, reason) => time.setReason(id, reason),
    'settings:get': () => time.getSettings(),
    'settings:update': (patch: Partial<Settings>) => {
      const previousFloatingEnabled = time.getSettings().floatingEnabled
      const s = time.updateSettings(patch)
      if (s.floatingEnabled !== previousFloatingEnabled) {
        floatIntent = 'auto'
        focusCaptureWhenReady = false
      }
      applySettings(s)
      return s
    },
    'ai:getConfig': () => aiConfig.view(),
    'ai:setConfig': (patch: AiConfigPatch) => aiConfig.update(patch),
    'ai:test': () => testAi(),
    'ai:parseCapture': (text: string) =>
      parseCapture(aiConfig.endpoint(), text, repo.listCategories(), repo.listTags(), new Date(), aiConfig.effort('capture'), habits.enabled()),
    'ai:reparseCapture': (text: string, previous: CaptureDraft, feedback: string[]) => {
      const notes = (Array.isArray(feedback) ? feedback : []).map((f) => String(f).trim().slice(0, 300)).filter(Boolean).slice(-5)
      if (!notes.length) throw new Error('写一句哪里不对')
      return reparseCapture(aiConfig.endpoint(), text, previous, notes, repo.listCategories(), repo.listTags(), new Date(), aiConfig.effort('capture'), habits.enabled())
    },
    'habits:list': () => habits.list(),
    'habits:add': (text: string, example?: string, replacesId?: string | null) => habits.add(text, example, replacesId ?? null),
    'habits:update': (id: string, patch: { text?: string; enabled?: boolean }) => habits.update(id, patch),
    'habits:remove': (id: string) => habits.remove(id),
    'habits:markUsed': (ids: string[]) => habits.markUsed(Array.isArray(ids) ? ids : []),
    'ai:parseSchedule': (files: ImportFile[], hint: string) =>
      parseSchedule(aiConfig.endpoint(files.some((f) => f.kind === 'image')), files, hint, aiConfig.effort('schedule')),
    'courses:list': () => courses.list(),
    'courses:commit': (draft: ScheduleDraft, replace: boolean) => courses.commit(draft, replace),
    'courses:removeAll': () => courses.removeAll(),
    'resurface:get': (day: string) => review.get(day),
    'resurface:act': (taskId: string, action: ResurfaceAction) => review.act(taskId, action),
    'resurface:reroll': (day: string) => review.reroll(day),
    'resurface:dismissTidy': (day: string) => review.dismissTidy(day),
    'review:summary': (day: string) => review.summary(day),
    'review:save': (day: string, input: DailyReviewInput) => review.save(day, input),
    'weekly:stats': (weekStart: string) => weekly.stats(weekStart),
    'weekly:activeWeeks': () => weekly.activeWeeks(),
    'weekly:get': (weekStart: string) => weekly.get(weekStart),
    'weekly:generate': (weekStart: string) => generateWeeklyReview(weekStart),
    'weekly:ask': (weekStart: string, question: string) => askWeeklyReview(weekStart, question),
    'weekly:apply': (weekStart: string, id: string) => weekly.apply(weekStart, id),
    'weekly:dismiss': (weekStart: string, id: string) => weekly.dismiss(weekStart, id),
    'insights:list': () => weekly.listInsights(),
    'insights:update': (id: string, patch: { status?: InsightStatus; text?: string }) => weekly.updateInsight(id, patch),
    'insights:remove': (id: string) => weekly.removeInsight(id),
    'planner:suggest': (day: string, hint: string) => suggestDayPlan(day, hint),
    'planner:accept': (_day: string, blocks: SuggestedBlock[]) => acceptDayPlan(blocks),
    'reminders:current': () => center.get(),
    'reminders:dismiss': (id: string, scope?: 'once' | 'group') => center.dismiss(id, scope),
    'reminders:snooze': (id: string, min: number) => center.snooze(id, min, new Date()),
    'win:openMain': (cmd?: MainCommand) => (cmd ? sendCommand(cmd) : showMain()),
    'win:showFloat': () => revealFloat(),
    'win:hideFloat': concealFloat,
    'win:status': (): SystemStatus => ({
      hotkeyRegistered,
      fullscreenDetection: isWindows && isFullscreenAppActive() !== null,
      platform: isWindows ? 'win32' : isMac ? 'darwin' : 'linux'
    })
  }
  const floatSurface = (e: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = [floatWin, floatOverlay].find((w) => !!w && !w.isDestroyed() && w.webContents === e.sender)
    if (!win || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) throw new Error('仅悬浮窗主帧可使用此通道')
    return win
  }

  ipcMain.handle('win:floatReady', (e) => {
    const win = floatSurface(e)
    if (win === floatOverlay) overlayBridgeReady = true
    else floatBridgeReady = true
    focusCapture()
  })
  ipcMain.handle('win:resizeFloat', (e, height: number) => {
    const win = floatSurface(e)
    if (!Number.isFinite(height)) return
    const [w] = win.getSize()
    const h = Math.max(60, Math.min(600, Math.round(height)))
    const b = win.getBounds()
    if (b.height === h) return
    // 不可调大小的透明窗口在 Windows 上 setSize 只会变高、不会变矮，改用 setBounds 并放开最小尺寸
    win.setMinimumSize(w, 60)
    win.setBounds({ x: b.x, y: b.y, width: w, height: h })
  })

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (e, ...args) => {
      if (timerWindow.owns(e.sender)) throw new Error('该窗口不能使用此通道')
      const result = (fn as (...a: unknown[]) => unknown)(...args)
      if (!READ_ONLY.has(channel) && !channel.startsWith('win:')) dataChanged(e.sender)
      return result
    })
  }
  ipcMain.handle('timer:state', (e) => {
    if (!timerWindow.accepts(e)) throw new Error('仅顶部计时器可使用此通道')
    return timerWindow.snapshot()
  })
  ipcMain.handle('timer:resize', (e, width: number) => {
    if (!timerWindow.accepts(e)) throw new Error('仅顶部计时器可使用此通道')
    timerWindow.resize(width)
  })
}

// ---------- 软件更新 ----------

function initializeUpdates(db: DatabaseSync): void {
  const version = app.getVersion()
  const mode = updateMode(process.platform, app.isPackaged)
  updatePrefs = new UpdatePreferences(db)
  if (app.isPackaged) logUpdate = updaterLog(app.getPath('userData'))
  let installedVersion: string | null = null
  if (app.isPackaged) {
    try { installedVersion = updatePrefs.recordStartup(version) } catch { logUpdate('could not record first startup version') }
  }
  const service = new UpdaterService({
    currentVersion: version,
    installedVersion,
    mode,
    prefs: updatePrefs,
    port: mode === 'download' ? windowsUpdater(logUpdate) : mode === 'check-only' ? macReleaseChecker() : undefined,
    publish: () => {
      restart.syncReadyVersion()
      publish()
      // 只有待安装版本改变时才重建托盘菜单，不随下载进度重建。
      if (service.readyVersion() !== trayUpdateVersion) updateTray()
    },
    log: logUpdate
  })
  const snapshot = (): UpdateSnapshot => ({ ...service.snapshot(), confirmation: restart.confirmation() })
  const publish = () => {
    const win = mainWin
    if (quitting || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try { win.webContents.send(UPDATE_IPC.changed, snapshot()) }
    catch { logUpdate('status delivery failed') }
  }
  const restart = new UpdateRestart({
    readyVersion: () => service.readyVersion(), running: () => time.running(), isQuitting: () => quitting,
    showMain, publish, install: installUpdate
  })
  updateRestart = restart
  updates = service
  const mainContents = () => mainWin?.webContents
  registerUpdateIpc(ipcMain, mainContents, {
    state: snapshot,
    check: () => service.check('manual'),
    setAutoCheck: (enabled) => service.setAutoCheck(enabled),
    restart: async () => { restart.request('main') },
    openExternal: (url) => shell.openExternal(url).catch(() => { throw new Error('无法打开浏览器，请稍后再试。') })
  })
  registerUpdateConfirmationIpc(ipcMain, mainContents, (id, accept) => restart.respond(id, accept))
}

function saveBeforeExit(version: string | null): void {
  if (exitSaved || !database) return
  exitSaved = true
  const db = database
  prepareUpdateExit(version, () => db.exec('PRAGMA wal_checkpoint(PASSIVE)'),
    (next) => snapshotBeforeUpdate(db, app.getPath('userData'), next), logUpdate)
}

function installUpdate(version: string): void {
  if (!updates || quitting) return
  try {
    try { updatePrefs?.expectRestart(version) } catch { logUpdate('could not save update restart marker') }
    // 更新库先启动安装器，再触发 before-quit；因此必须在调用它之前保存。
    saveBeforeExit(version)
    quitting = true
    updates.installNow()
  } catch {
    quitting = false
    exitSaved = false
    try { updatePrefs?.expectRestart(null) } catch { logUpdate('could not clear update restart marker') }
    logUpdate('could not start explicit update')
    throw new Error('无法启动更新安装程序，请稍后再试。')
  }
}

// ---------- 窗口 ----------

const webPreferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  sandbox: true
})

const macWorkspaces = new MacWorkspaces(() => app.dock)
const timerWindow = new TimerWindow(
  () => ({ ...webPreferences(), additionalArguments: ['--planreview-timer'] }),
  loadRenderer,
  macWorkspaces
)

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

function syncMainWindowTheme(): void {
  const win = mainWin
  if (!win || win.isDestroyed()) return
  updateMainWindowChrome(win, nativeTheme.shouldUseDarkColors)
}

function createMainWindow(): void {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: '计划与复盘',
    icon: resource('icon.png'),
    ...mainWindowChrome(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences()
  })
  mainWin.once('ready-to-show', () => {
    // 开机自启：Windows 传 --hidden；macOS 不支持启动参数，用系统给的 wasOpenedAtLogin 判断
    const atLogin = isMac && app.getLoginItemSettings().wasOpenedAtLogin
    if (updates?.snapshot().installedVersion || (!process.argv.includes('--hidden') && !atLogin)) mainWin?.show()
  })
  // 外部链接交给系统浏览器
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 关闭主窗口时默认缩到托盘，悬浮窗和提醒继续工作
  mainWin.on('close', (e) => {
    if (!quitting && time.getSettings().closeToTray) {
      e.preventDefault()
      mainWin?.hide()
    }
  })
  const invalidateUpdateConfirmation = () => updateRestart?.invalidate()
  mainWin.webContents.on('did-start-navigation', updateConfirmationNavigation(invalidateUpdateConfirmation))
  mainWin.webContents.on('render-process-gone', invalidateUpdateConfirmation)
  mainWin.on('hide', invalidateUpdateConfirmation)
  mainWin.on('closed', () => {
    mainWin = null
    invalidateUpdateConfirmation()
  })
  loadRenderer(mainWin)
}

function showMain(): void {
  if (quitting) return
  if (!mainWin || mainWin.isDestroyed()) createMainWindow()
  if (mainWin!.isMinimized()) mainWin!.restore()
  mainWin!.show()
  mainWin!.focus()
}

function createFloatWindow(): void {
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
    webPreferences: webPreferences()
  })
  floatWin = win
  win.setAlwaysOnTop(true, 'floating')
  win.webContents.on('did-start-loading', () => { floatBridgeReady = false })
  win.webContents.once('render-process-gone', () => win.destroy())
  win.once('closed', () => {
    floatWin = null
    floatReady = false
    floatBridgeReady = false
    macWorkspaces.forget(win)
  })
  win.once('ready-to-show', () => {
    floatReady = true
    updateDesktopVisibility()
  })
  void loadRenderer(win, '#float').catch((err: unknown) => {
    if (win.isDestroyed()) return
    console.error('Failed to load the floating window', err)
    win.destroy()
  })
}

/** macOS：在需要覆盖全屏 Space 时使用 NSPanel；普通悬浮窗仍保持普通窗口 */
function createFloatOverlay(): void {
  if (!isMac || (floatOverlay && !floatOverlay.isDestroyed())) return
  const b = floatWin && !floatWin.isDestroyed()
    ? floatWin.getBounds()
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
    webPreferences: webPreferences()
  })
  floatOverlay = win
  overlayReady = false
  overlayBridgeReady = false
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.on('did-start-loading', () => { overlayBridgeReady = false })
  const fallBack = () => {
    // 过期加载回调不得影响后续新建的覆盖层或用户已经隐藏的窗口。
    if (floatOverlay !== win || win.isDestroyed()) return
    overlayFailed = true
    win.destroy()
    updateDesktopVisibility()
  }
  win.webContents.once('render-process-gone', fallBack)
  win.once('closed', () => {
    if (floatOverlay !== win) return
    floatOverlay = null
    overlayReady = false
    overlayBridgeReady = false
  })
  win.once('ready-to-show', () => {
    if (floatOverlay !== win || win.isDestroyed()) return
    overlayReady = true
    // 加载期间可能已经隐藏或切换任务，重新判断可见性，避免迟到的回调弹出第二张卡片。
    updateDesktopVisibility()
  })
  void loadRenderer(win, '#float').catch((err: unknown) => {
    if (floatOverlay !== win || win.isDestroyed()) return
    console.error('Failed to load the fullscreen float overlay', err)
    fallBack()
  })
}

function destroyFloatOverlay(): void {
  const win = floatOverlay
  floatOverlay = null
  overlayReady = false
  overlayBridgeReady = false
  overlayFailed = false
  win?.destroy()
}

function updateDesktopVisibility(s = time.getSettings(), running = time.running(), reminder = center.get()): void {
  if (quitting) return
  const runningId = running?.id ?? null
  if (runningId !== lastRunningId) focusCaptureWhenReady = false
  floatIntent = floatIntentAfterTimerChange(floatIntent, lastRunningId, runningId)
  lastRunningId = runningId
  const visible = desktopVisibility(s, running !== null, fullscreenNow, floatIntent, reminder)
  timerWindow.update(running, visible.timer, s.hideInFullscreen)

  const coverFullscreen = isMac && floatMayCoverMacFullscreen(visible.float, s.hideInFullscreen, floatIntent, reminder)
  if (coverFullscreen && !overlayFailed) {
    if (!floatOverlay || floatOverlay.isDestroyed()) createFloatOverlay()
    if (floatOverlay && overlayReady && !floatOverlay.isVisible()) floatOverlay.showInactive()
    // 覆盖层和普通悬浮窗不能同时显示，否则桌面会出现两个同样的卡片
    floatWin?.hide()
    if (floatWin && floatReady) macWorkspaces.update(floatWin, false)
  } else if (coverFullscreen) {
    // 覆盖层失败：保留普通悬浮窗作为回退，不再反复重建覆盖层。
    if (floatWin && floatReady && !floatWin.isVisible() && floatIntent !== 'hide') floatWin.showInactive()
    if (floatWin && floatReady) macWorkspaces.update(floatWin, false)
  } else {
    destroyFloatOverlay()
    if (floatWin && floatReady) macWorkspaces.update(floatWin, false)
  }
  if (!visible.float) {
    destroyFloatOverlay()
    if (!s.floatingEnabled) floatWin?.destroy()
    else floatWin?.hide()
  } else if (!floatWin) {
    createFloatWindow()
  } else if (floatReady) {
    // 覆盖层正在显示时不能把普通窗口再 show 回来，否则又是两个卡片
    if (!coverFullscreen && !floatWin.isVisible()) floatWin.showInactive()
    focusCapture()
  }
}

function focusCapture(): void {
  const surface = floatOverlay && overlayReady && !floatOverlay.isDestroyed() ? floatOverlay : floatWin
  const bridge = surface === floatOverlay ? overlayBridgeReady : floatBridgeReady
  if (!focusCaptureWhenReady || !surface || !bridge || !surface.isVisible()) return
  focusCaptureWhenReady = false
  surface.show()
  surface.focus()
  surface.webContents.send('focus-capture')
}

function revealFloat(capture = false): void {
  floatIntent = 'show'
  focusCaptureWhenReady = capture
  updateDesktopVisibility()
  updateTray()
}

function concealFloat(): void {
  floatIntent = 'hide'
  focusCaptureWhenReady = false
  updateDesktopVisibility()
  updateTray()
}

/** 快捷键：唤出悬浮窗并聚焦速记框 */
function toggleCapture(): void {
  revealFloat(true)
}

// ---------- 托盘 ----------

function watchTheme(): void {
  // 跟随系统时，系统切换深浅色后主窗口底色也跟着换
  nativeTheme.on('updated', syncMainWindowTheme)
}

/** macOS 的全局菜单栏：Electron 默认菜单是英文的，这里换成中文，并保留编辑/窗口的标准角色 */
function createAppMenu(): void {
  if (!isMac) return
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about', label: '关于计划与复盘' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏计划与复盘' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出计划与复盘' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { label: '打开主窗口', click: showMain },
        { role: 'front', label: '前置全部窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com/Anthony-xyr/PlanReview')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray(): void {
  tray = new Tray(trayIcon('idle'))
  tray.setToolTip('计划与复盘')
  // macOS 上点击托盘图标会直接弹出菜单（菜单第一项就是打开主窗口）；Windows 左键直接开窗口
  if (isMac) tray.setIgnoreDoubleClickEvents(true)
  else tray.on('click', showMain)
  updateTray()
}

function updateTray(): void {
  if (!tray || quitting) return
  trayUpdateVersion = updates?.readyVersion() ?? null
  const running = time.running()
  const s = time.getSettings()
  const floatShown = desktopVisibility(s, running !== null, fullscreenNow, floatIntent, center.get()).float
  tray.setImage(trayIcon(running ? 'running' : 'idle'))
  tray.setToolTip(running ? `计时中：${running.title}` : '计划与复盘')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: showMain },
      { label: `速记（${hotkeyLabel(s.hotkey, process.platform)}）`, click: toggleCapture },
      ...(isMac
        ? [
            // 在另一个 Space 的窗口也可能被 Electron 视作可见，始终保留主动唤出的入口。
            { label: '显示悬浮窗', click: () => revealFloat() },
            ...(floatShown ? [{ label: '隐藏悬浮窗', click: concealFloat }] : [])
          ]
        : [{ label: floatShown ? '隐藏悬浮窗' : '显示悬浮窗', click: () => (floatShown ? concealFloat() : revealFloat()) }]),
      { type: 'separator' },
      ...(running ? [{ label: `结束本次：${running.title}`, click: () => sendCommand('stop') }] : []),
      { label: '收尾', click: () => sendCommand('wrap-up') },
      { label: '今日复盘', click: () => sendCommand('review') },
      { label: '周复盘', click: () => sendCommand('weekly') },
      { type: 'separator' },
      ...(trayUpdateVersion ? [{
        label: `重启并更新到 ${trayUpdateVersion}`,
        click: () => {
          try { updateRestart?.request('tray') } catch { logUpdate('tray restart failed') }
        }
      }] : []),
      { label: '退出', click: () => app.quit() }
    ])
  )
}

// ---------- 设置 ----------

function applySettings(s: Settings): void {
  if (s.hotkey !== registeredHotkey) {
    if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
    try {
      hotkeyRegistered = globalShortcut.register(s.hotkey, toggleCapture)
    } catch {
      hotkeyRegistered = false
    }
    registeredHotkey = hotkeyRegistered ? s.hotkey : ''
  }
  if (app.isPackaged) {
    // 只在状态变化时写系统登录项：每次启动都写的话，未签名的包会被 macOS 拒绝并打一条错误。
    // Windows 的登录项带 --hidden 参数；读取时必须传入同一组 args，否则 Electron 会认为
    // 该项不存在，取消勾选时就不会删除 Run 值。
    const current = app.getLoginItemSettings(isMac ? undefined : { args: ['--hidden'] }).openAtLogin
    if (current !== s.launchAtLogin) {
      // macOS 的登录项不接收启动参数，靠 wasOpenedAtLogin 判断；Windows 用 --hidden
      if (isMac) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
      else app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] })
    }
  }
  // 界面的深浅色走 CSS 的 prefers-color-scheme，这里定下它取系统的还是固定一种
  nativeTheme.themeSource = s.theme
  syncMainWindowTheme()
}

// ---------- 提醒循环 ----------

function tick(): void {
  if (quitting) return
  const now = new Date()
  const settings = time.getSettings()
  const snapshot = reminderSnapshot(time, now, settings)
  const { running } = snapshot
  const reminder = center.evaluate(snapshot)

  const full = isWindows && settings.hideInFullscreen && isFullscreenAppActive() === true
  if (full !== fullscreenNow) {
    fullscreenNow = full
    if (full && floatIntent === 'show') floatIntent = 'auto'
  }

  // 内容变化就重新推送（比如同一个睡眠提醒，开始计时后文字要跟着变）
  const sig = reminder ? JSON.stringify({ ...reminder, fresh: undefined }) : null
  if (sig !== lastReminderSig) {
    lastReminderSig = sig
    for (const w of allWindows()) w.webContents.send('reminder', reminder)
  }
  floatIntent = floatIntentAfterReminder(floatIntent, reminder)
  updateDesktopVisibility(settings, running, reminder)
  if (reminder?.fresh) notify(reminder, settings)
  updateTray()
}

/** 系统通知：悬浮窗不可见时（全屏、关掉了）也能看到；强提醒带声音 */
function notify(r: Reminder, s: Settings): void {
  if (!Notification.isSupported()) return
  const floatVisible = floatWin && !floatWin.isDestroyed() && floatWin.isVisible()
  if (floatVisible && !r.strong) return
  const n = new Notification({
    title: r.title,
    body: r.body,
    silent: !(r.strong && s.strongSound),
    urgency: r.strong ? 'critical' : 'normal',
    // macOS 的通知不读自定义图标，直接显示应用图标
    ...(isMac ? {} : { icon: resource('icon.png') })
  })
  n.on('click', () => (time.getSettings().floatingEnabled ? revealFloat() : showMain()))
  n.show()
}

// ---------- 启动 ----------

// 开发版和安装版用同一个数据目录：Windows 在 %APPDATA%\plan-review，macOS 在
// ~/Library/Application Support/plan-review，装好后之前的数据还在。
// 要在 requestSingleInstanceLock 之前设，单实例锁也放在这个目录里
app.setPath('userData', join(app.getPath('appData'), 'plan-review'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMain)

  app.whenReady().then(() => {
    if (isWindows) app.setAppUserModelId('plan-review')
    // 开发时 Dock 默认是 Electron 的图标，换成应用自己的；打包后由 .icns 决定
    if (isMac && !app.isPackaged) app.dock?.setIcon(resource('icon.png'))
    if (process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin)) {
      suppressActivateUntil = Date.now() + 3000
    }
    createAppMenu()
    openDatabase()
    initializeUpdates(database!)
    registerIpc()
    const settings = time.getSettings()
    // 创建窗口前设置主题，让首帧、页面媒体查询和原生按钮颜色一致。
    nativeTheme.themeSource = settings.theme
    createMainWindow()
    createTray()
    watchTheme()
    applySettings(settings)
    tick()
    tickInterval = setInterval(tick, TICK_MS)
    updates?.start()
  })

  // macOS：点 Dock 图标时把主窗口叫回来（窗口被缩到托盘后也有效）
  if (isMac) app.on('activate', () => {
    if (Date.now() < suppressActivateUntil) return
    showMain()
  })

  app.on('before-quit', () => {
    quitting = true
    updateRestart?.invalidate()
    saveBeforeExit(updates?.readyVersion() ?? null)
  })
  app.on('will-quit', () => {
    updates?.dispose()
    clearInterval(tickInterval)
    timerWindow.dispose()
    globalShortcut.unregisterAll()
  })
  // 有托盘时关闭所有窗口也不退出
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
}
