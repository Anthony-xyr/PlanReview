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
import { dayOf, dayRange } from '@shared/time'
import { migrate } from './db/schema'
import { Repo } from './db/repo'
import { TimeRepo, sleepWindow } from './db/timeRepo'
import { ReminderCenter } from './reminders'
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

const FLOAT_WIDTH = 320
const TICK_MS = 15_000

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
let quitting = false
let hotkeyRegistered = false
let registeredHotkey = ''
let floatHiddenByUser = false
let fullscreenNow = false
let lastReminderSig: string | null = null

// 打包后 resources/ 解压在 app.asar.unpacked 里，托盘和系统通知能直接读到图标文件
const resource = (name: string) => join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', name)

function openDatabase(): void {
  const db = new DatabaseSync(join(app.getPath('userData'), 'plan-review.db'))
  migrate(db)
  repo = new Repo(db)
  time = new TimeRepo(db)
  center = new ReminderCenter(time)
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
  return [mainWin, floatWin].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
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
  'tasks:list', 'tasks:get', 'tasks:lineage', 'categories:list', 'tags:list', 'plan:list',
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
    'plan:create': (input) => time.createBlock(input),
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
      const s = time.updateSettings(patch)
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
    'win:showFloat': () => {
      floatHiddenByUser = false
      updateFloatVisibility()
    },
    'win:hideFloat': () => {
      floatHiddenByUser = true
      updateFloatVisibility()
    },
    'win:resizeFloat': (height: number) => {
      if (!floatWin || floatWin.isDestroyed()) return
      const [w] = floatWin.getSize()
      const h = Math.max(60, Math.min(600, Math.round(height)))
      // 不可调大小的透明窗口在 Windows 上 setSize 只会变高、不会变矮，改用 setBounds 并放开最小尺寸
      const b = floatWin.getBounds()
      if (b.height === h) return
      floatWin.setMinimumSize(w, 60)
      floatWin.setBounds({ x: b.x, y: b.y, width: w, height: h })
    },
    'win:status': (): SystemStatus => ({ hotkeyRegistered, fullscreenDetection: isFullscreenAppActive() !== null })
  }
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (e, ...args) => {
      const result = (fn as (...a: unknown[]) => unknown)(...args)
      if (!READ_ONLY.has(channel) && !channel.startsWith('win:')) dataChanged(e.sender)
      return result
    })
  }
}

// ---------- 窗口 ----------

const webPreferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  sandbox: true
})

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

function createMainWindow(): void {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: '计划与复盘',
    icon: resource('icon.png'),
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences()
  })
  mainWin.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWin?.show()
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
  mainWin.on('closed', () => (mainWin = null))
  loadRenderer(mainWin)
}

/** 窗口还没画出界面前的底色，和 CSS 里 --bg 一致，免得深色模式下先闪一下白 */
function windowBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#1f1f22' : '#fbfbfa'
}

function showMain(): void {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow()
  if (mainWin!.isMinimized()) mainWin!.restore()
  mainWin!.show()
  mainWin!.focus()
}

function createFloatWindow(): void {
  const area = screen.getPrimaryDisplay().workArea
  floatWin = new BrowserWindow({
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
  floatWin.setAlwaysOnTop(true, 'floating')
  floatWin.on('closed', () => (floatWin = null))
  floatWin.once('ready-to-show', updateFloatVisibility)
  loadRenderer(floatWin, '#float')
}

function updateFloatVisibility(): void {
  const s = time.getSettings()
  if (!s.floatingEnabled) {
    floatWin?.destroy()
    return
  }
  if (!floatWin || floatWin.isDestroyed()) return createFloatWindow()
  const reminder = center.get()
  // 全屏时隐藏；但强提醒（睡眠）仍然要露面
  const hide = floatHiddenByUser || (s.hideInFullscreen && fullscreenNow && !reminder?.strong)
  if (hide) floatWin.hide()
  else if (!floatWin.isVisible()) floatWin.showInactive()
}

/** 快捷键：唤出悬浮窗并聚焦速记框 */
function toggleCapture(): void {
  floatHiddenByUser = false
  if (!floatWin || floatWin.isDestroyed()) {
    createFloatWindow()
    floatWin!.webContents.once('did-finish-load', () => toggleCapture())
    return
  }
  floatWin.show()
  floatWin.focus()
  floatWin.webContents.send('focus-capture')
}

// ---------- 托盘 ----------

function watchTheme(): void {
  // 跟随系统时，系统切换深浅色后主窗口底色也跟着换
  nativeTheme.on('updated', () => mainWin?.setBackgroundColor(windowBg()))
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(resource('tray.png')))
  tray.setToolTip('计划与复盘')
  tray.on('click', showMain)
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const running = time.running()
  const s = time.getSettings()
  tray.setImage(nativeImage.createFromPath(resource(running ? 'tray-running.png' : 'tray.png')))
  tray.setToolTip(running ? `计时中：${running.title}` : '计划与复盘')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: showMain },
      { label: `速记（${s.hotkey}）`, click: toggleCapture },
      {
        label: s.floatingEnabled && !floatHiddenByUser ? '隐藏悬浮窗' : '显示悬浮窗',
        click: () => {
          if (!s.floatingEnabled) time.updateSettings({ floatingEnabled: true })
          else floatHiddenByUser = !floatHiddenByUser
          updateFloatVisibility()
          updateTray()
        }
      },
      { type: 'separator' },
      ...(running ? [{ label: `结束本次：${running.title}`, click: () => sendCommand('stop') }] : []),
      { label: '收尾', click: () => sendCommand('wrap-up') },
      { label: '今日复盘', click: () => sendCommand('review') },
      { label: '周复盘', click: () => sendCommand('weekly') },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
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
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] })
  // 界面的深浅色走 CSS 的 prefers-color-scheme，这里定下它取系统的还是固定一种
  nativeTheme.themeSource = s.theme
  mainWin?.setBackgroundColor(windowBg())
  updateFloatVisibility()
  updateTray()
}

// ---------- 提醒循环 ----------

function tick(): void {
  const now = new Date()
  const settings = time.getSettings()
  const { start, end } = dayRange(dayOf(now, settings.dayStartHour), settings.dayStartHour)
  const reminder = center.evaluate({
    now,
    settings,
    running: time.running(),
    blocks: time.listBlocks(start.toISOString(), new Date(end.getTime() + 6 * 3_600_000).toISOString())
  })

  const full = settings.hideInFullscreen ? isFullscreenAppActive() === true : false
  if (full !== fullscreenNow) fullscreenNow = full

  // 内容变化就重新推送（比如同一个睡眠提醒，开始计时后文字要跟着变）
  const sig = reminder ? JSON.stringify({ ...reminder, fresh: undefined }) : null
  if (sig !== lastReminderSig) {
    lastReminderSig = sig
    for (const w of allWindows()) w.webContents.send('reminder', reminder)
  }
  if (reminder?.fresh) notify(reminder, settings)
  updateFloatVisibility()
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
    icon: resource('icon.png')
  })
  n.on('click', () => (floatVisible ? floatWin?.show() : showMain()))
  n.show()
}

// ---------- 启动 ----------

// 开发版和安装版用同一个数据目录（%APPDATA%\plan-review），装好后之前的数据还在。
// 要在 requestSingleInstanceLock 之前设，单实例锁也放在这个目录里
app.setPath('userData', join(app.getPath('appData'), 'plan-review'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMain)

  app.whenReady().then(() => {
    app.setAppUserModelId('plan-review')
    openDatabase()
    registerIpc()
    createMainWindow()
    createTray()
    watchTheme()
    applySettings(time.getSettings())
    tick()
    setInterval(tick, TICK_MS)
  })

  app.on('before-quit', () => (quitting = true))
  app.on('will-quit', () => globalShortcut.unregisterAll())
  // 有托盘时关闭所有窗口也不退出
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
}
