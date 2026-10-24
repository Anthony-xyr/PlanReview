import { useCallback, useEffect, useState } from 'react'
import type { Category, Settings, StartTimerInput, Task, TimeEntry } from '@shared/types'
import { TasksView, type TaskViewKind } from './components/TasksView'
import { TodayView } from './components/TodayView'
import { SettingsDialog } from './components/SettingsDialog'
import { ImportDialog } from './components/ImportDialog'
import { DailyReviewDialog } from './components/DailyReviewDialog'
import { WeeklyView } from './components/WeeklyView'
import { InsightsDialog } from './components/InsightsDialog'
import { PlannerDialog } from './components/PlannerDialog'
import { ExtendDialog, StopDialog, TimerBar } from './components/Timer'
import { WrapUpDialog } from './components/WrapUpDialog'
import { ReminderCard } from './components/ReminderCard'
import { errorText, type Mutate } from './ui'
import { reminderActions, useReminder } from './reminderActions'
import { dayOf } from '@shared/time'

export type View = { kind: 'today' } | { kind: 'weekly' } | TaskViewKind

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b)

export function App() {
  const [view, setView] = useState<View>({ kind: 'today' })
  const [version, setVersion] = useState(0)
  const [categories, setCategories] = useState<Category[]>([])
  const [inboxCount, setInboxCount] = useState(0)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [runningTask, setRunningTask] = useState<Task | null>(null)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [extending, setExtending] = useState(false)
  const [wrapUp, setWrapUp] = useState(false)
  const reminder = useReminder()
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [importing, setImporting] = useState(false)
  const [reviewDay, setReviewDay] = useState<string | null>(null)
  const [showInsights, setShowInsights] = useState(false)
  const [planDay, setPlanDay] = useState<string | null>(null)

  // 提示一句话并刷新各页面
  const notify = useCallback((text: string, error?: boolean) => {
    setToast({ text, error })
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    ;(async () => {
      const [c, inbox, s, r] = await Promise.all([
        window.api.categories.list(),
        window.api.tasks.list({ status: 'inbox' }),
        window.api.settings.get(),
        window.api.entries.running()
      ])
      setCategories(c)
      setInboxCount(inbox.length)
      setSettings(s)
      setRunning(r)
      setRunningTask(r?.taskId ? await window.api.tasks.get(r.taskId) : null)
    })().catch((e) => setToast({ text: errorText(e), error: true }))
  }, [version])

  // 其他窗口（悬浮窗）改了数据，或托盘 / 悬浮窗请求打开某个流程
  useEffect(() => {
    const offData = window.api.events.onDataChanged(() => setVersion((v) => v + 1))
    const offCmd = window.api.events.onCommand((cmd) => {
      if (cmd === 'stop') setStopping(true)
      if (cmd === 'wrap-up') setWrapUp(true)
      if (cmd === 'review') window.api.settings.get().then((s) => setReviewDay(dayOf(new Date(), s.dayStartHour)))
      if (cmd === 'weekly') setView({ kind: 'weekly' })
      if (cmd === 'today') setView({ kind: 'today' })
    })
    return () => {
      offData()
      offCmd()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  const mutate: Mutate = useCallback(async (fn) => {
    try {
      const result = await fn()
      setVersion((v) => v + 1)
      return result
    } catch (e) {
      setToast({ text: errorText(e), error: true })
      setVersion((v) => v + 1)
      return undefined
    }
  }, [])

  const startTimer = (input: StartTimerInput) => mutate(() => window.api.entries.start(input))

  const nav = (v: View, label: string, extra?: { color?: string; count?: number }) => (
    <button
      className={`nav-item ${sameView(view, v) ? 'is-active' : ''}`}
      aria-current={sameView(view, v) ? 'page' : undefined}
      onClick={() => setView(v)}
    >
      {extra?.color && <span className="dot" style={{ background: extra.color }} aria-hidden />}
      <span className="nav-label">{label}</span>
      {!!extra?.count && <span className="count">{extra.count}</span>}
    </button>
  )

  if (!settings) return null
  // 类别入口打开时停在第一个现有类别
  const firstCategory = categories.find((c) => !c.archived)?.id ?? null

  return (
    <div className="app">
      <nav className="sidebar" aria-label="视图">
        <div className="brand">计划与复盘</div>
        {nav({ kind: 'today' }, '今天')}
        {nav({ kind: 'inbox' }, '收件箱', { count: inboxCount })}
        {nav({ kind: 'active' }, '待办')}
        {nav({ kind: 'done' }, '已结束')}
        {nav({ kind: 'weekly' }, '周复盘')}
        <button
          className={`nav-item ${view.kind === 'category' ? 'is-active' : ''}`}
          aria-current={view.kind === 'category' ? 'page' : undefined}
          onClick={async () => {
            if (view.kind === 'category') return
            // 停在第一个有没结束任务的类别，都没有就停在第一个
            const counts = await window.api.categories.openCounts()
            setView({ kind: 'category', id: categories.find((c) => !c.archived && counts[c.id])?.id ?? firstCategory })
          }}
        >
          <span className="nav-label">类别</span>
        </button>
        <div className="spacer" />
        <button className="nav-item" onClick={() => setReviewDay(dayOf(new Date(), settings.dayStartHour))}>
          今日复盘
        </button>
        <button className="nav-item" onClick={() => setShowInsights(true)}>
          个人画像
        </button>
        <button className="nav-item" onClick={() => setImporting(true)}>
          导入课表
        </button>
        <button className="nav-item" onClick={() => setWrapUp(true)}>
          收尾
        </button>
        <button className="nav-item" onClick={() => window.api.win.showFloat()}>
          显示悬浮窗
        </button>
        <button className="nav-item" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </nav>

      <div className="content">
        {running && <TimerBar running={running} onStop={() => setStopping(true)} onExtend={() => setExtending(true)} />}
        {reminder && (
          <div className="reminder-host">
            <ReminderCard
              reminder={reminder}
              {...reminderActions(reminder, mutate, { onStop: () => setStopping(true), onWrapUp: () => setWrapUp(true) })}
            />
          </div>
        )}
        {view.kind === 'weekly' ? (
          <WeeklyView settings={settings} categories={categories} version={version} mutate={mutate} onOpenSettings={() => setShowSettings(true)} />
        ) : view.kind === 'today' ? (
          <TodayView
            key={dayOf(new Date(), settings.dayStartHour)}
            settings={settings}
            categories={categories}
            version={version}
            mutate={mutate}
            running={running}
            onStartTimer={startTimer}
            onOpenInbox={() => setView({ kind: 'inbox' })}
            onOpenReview={setReviewDay}
            onOpenPlanner={setPlanDay}
            notify={notify}
          />
        ) : (
          <TasksView
            view={view}
            categories={categories}
            version={version}
            mutate={mutate}
            running={running}
            onStartTimer={startTimer}
            onNavigate={setView}
            notify={notify}
          />
        )}
      </div>

      {toast && (
        <div className={`toast ${toast.error ? 'is-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.text}
        </div>
      )}

      {stopping && running && (
        <StopDialog
          running={running}
          task={runningTask}
          overrunRatio={settings.overrunAskRatio}
          onClose={() => setStopping(false)}
          onConfirm={async (input) => {
            setStopping(false)
            const r = await mutate(() => window.api.entries.stop(input))
            if (r?.discarded) setToast({ text: '这次不到 1 分钟，没有保存记录' })
            else if (r) setToast({ text: input.complete ? '已结束并完成任务' : '已结束本次投入，任务留在待办里' })
          }}
        />
      )}

      {extending && running && (
        <ExtendDialog
          step={settings.extendStepMin}
          onClose={() => setExtending(false)}
          onExtend={async (min) => {
            setExtending(false)
            await mutate(() => window.api.entries.extend(min))
          }}
          onClear={async () => {
            setExtending(false)
            await mutate(() => window.api.entries.setTarget(null))
          }}
        />
      )}

      {wrapUp && (
        <WrapUpDialog
          settings={settings}
          mutate={mutate}
          onClose={() => setWrapUp(false)}
          onReview={() => {
            setWrapUp(false)
            setReviewDay(dayOf(new Date(), settings.dayStartHour))
          }}
        />
      )}

      {showInsights && <InsightsDialog mutate={mutate} onClose={() => setShowInsights(false)} />}
      {planDay && (
        <PlannerDialog
          day={planDay}
          mutate={mutate}
          onClose={() => setPlanDay(null)}
          onDone={(msg) => {
            setPlanDay(null)
            notify(msg)
          }}
        />
      )}
      {reviewDay && (
        <DailyReviewDialog
          key={reviewDay}
          day={reviewDay}
          categories={categories}
          mutate={mutate}
          onClose={() => setReviewDay(null)}
          onSwitchDay={setReviewDay}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onOpenSettings={() => {
            setImporting(false)
            setShowSettings(true)
          }}
          onDone={(msg) => {
            setImporting(false)
            setToast({ text: msg })
            setVersion((v) => v + 1)
            setView({ kind: 'today' })
          }}
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            const ok = await mutate(() => window.api.settings.update(patch))
            if (ok) setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}
