import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Category, PlanBlock, Settings, StartTimerInput, Task, TimeEntry } from '@shared/types'
import { dayOf, dayRange, formatElapsed, hhmm } from '@shared/time'
import { remainingMin } from '@shared/session'
import { ReminderCard } from '../components/ReminderCard'
import { errorText } from '../ui'
import { reminderActions, useReminder } from '../reminderActions'
import { CaptureConfirm, useSmartCapture } from '../capture'
import { matchesPickerQuery, planTimerInput, selectFloatWork } from './floatWork'

interface FloatData {
  running: TimeEntry | null
  settings: Settings
  categories: Category[]
  blocks: PlanBlock[]
  tasks: Task[]
  startedPlanIds: Set<string>
  day: string
}

/**
 * 悬浮窗：显示当前事项和计时、下一件事、速记框。
 * 窗口高度跟随内容。
 */
export function FloatApp() {
  const [data, setData] = useState<FloatData | null>(null)
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [captureExpanded, setCaptureExpanded] = useState(false)
  const [captureFocus, setCaptureFocus] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [starting, setStarting] = useState(false)
  const pickerId = useId()
  const reminder = useReminder()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadId = useRef(0)
  const startPending = useRef(false)

  const load = useCallback(async () => {
    const id = ++loadId.current
    try {
      const [running, settings, cats, tasks] = await Promise.all([
        window.api.entries.running(), window.api.settings.get(), window.api.categories.list(),
        window.api.tasks.list({ status: 'active' })
      ])
      const day = dayOf(new Date(), settings.dayStartHour)
      const { start, end } = dayRange(day, settings.dayStartHour)
      const [blocks, started] = await Promise.all([
        window.api.plan.list(start.toISOString(), end.toISOString()),
        window.api.plan.startedIds(start.toISOString(), end.toISOString())
      ])
      if (id !== loadId.current) return
      setData({ running, settings, categories: cats.filter((c) => !c.archived), blocks, tasks, startedPlanIds: new Set(started), day })
    } catch (err) {
      if (id === loadId.current) setFlash({ text: errorText(err), error: true })
    }
  }, [])

  useEffect(() => {
    const offData = window.api.events.onDataChanged(() => { void load() })
    const offFocus = window.api.onFocusCapture(() => {
      setCaptureExpanded(true)
      setCaptureFocus((n) => n + 1)
    })
    void window.api.win.floatReady().catch((err: unknown) => console.error(err))
    const t = setInterval(() => setNow(new Date()), 1000)
    const onVisibility = () => {
      if (!document.hidden) {
        setNow(new Date())
        void load()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    void load()
    return () => {
      ++loadId.current
      offData()
      offFocus()
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  const day = data && dayOf(now, data.settings.dayStartHour)
  const loadedDay = data?.day
  useEffect(() => {
    if (day && day !== loadedDay) void load()
  }, [day, loadedDay, load])

  useLayoutEffect(() => {
    if (captureExpanded) inputRef.current?.focus()
  }, [captureExpanded, captureFocus])

  // 窗口高度跟随内容
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      void window.api.win.resizeFloat(el.getBoundingClientRect().height + 2).catch((err: unknown) => console.error(err))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2200)
    return () => clearTimeout(t)
  }, [flash])

  const run = async <T,>(fn: () => Promise<T>) => {
    try {
      const r = await fn()
      await load()
      return r
    } catch (e) {
      setFlash({ text: errorText(e), error: true })
      return undefined
    }
  }

  const smart = useSmartCapture({
    onSaved: (_t, msg) => setFlash({ text: msg === '已记下' ? '已存进收件箱' : msg }),
    onError: (msg) => setFlash({ text: msg, error: true })
  })

  const capture = async () => {
    if (await smart.submit(text)) {
      setText('')
      setCaptureExpanded(false)
    }
  }

  const closeCapture = () => {
    setText('')
    setCaptureExpanded(false)
    inputRef.current?.blur()
  }

  const { running, settings, categories } = data ?? { running: null, settings: null, categories: [] }
  const { current, upcoming, unscheduled } = useMemo(() => data && day === data.day
    ? selectFloatWork(data.tasks, data.blocks, data.startedPlanIds, now)
    : { current: null, upcoming: [], unscheduled: [] }, [data, day, now])
  const next = upcoming[0]
  const left = running ? remainingMin(running, now) : null
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]))
  const tasksForPicker = unscheduled.filter((t) => matchesPickerQuery([t.title, ...t.tags, categoryNames.get(t.categoryId ?? '')], query))
  const plansForPicker = upcoming.filter((b) => matchesPickerQuery([b.title, b.location, categoryNames.get(b.categoryId ?? ''), hhmm(b.startAt)], query))

  const start = async (input: StartTimerInput) => {
    if (startPending.current) return
    startPending.current = true
    setStarting(true)
    try {
      if (await run(() => window.api.entries.start(input))) {
        setPickerOpen(false)
        setQuery('')
      }
    } finally {
      startPending.current = false
      setStarting(false)
    }
  }
  const startPlan = (block: PlanBlock) => start(planTimerInput(block, new Date()))

  return (
    <div className="float" ref={rootRef}>
      <div className="float-bar">
        <span className="float-brand" aria-hidden />
        <span className="float-drag">计划与复盘</span>
        <button className="float-btn" title="打开主窗口" aria-label="打开主窗口" onClick={() => window.api.win.openMain('today')}>
          ⤢
        </button>
        <button className="float-btn" title="隐藏（托盘菜单可以再打开）" aria-label="隐藏悬浮窗" onClick={() => window.api.win.hideFloat()}>
          ×
        </button>
      </div>

      <div className="float-content">
        {reminder && (
          <ReminderCard
            compact
            reminder={reminder}
            {...reminderActions(reminder, run, {
              onStop: () => window.api.win.openMain('stop'),
              onWrapUp: () => window.api.win.openMain('wrap-up')
            })}
          />
        )}

        {!smart.pending && (running ? (
          <div className="float-now">
            <div className="float-label">
              <span className="pulse" aria-hidden /> 正在进行
            </div>
            <div className="float-title">{running.title}</div>
            <div className="float-time">
              <span className="elapsed">{formatElapsed(now.getTime() - Date.parse(running.startAt))}</span>
              {left !== null && (
                <span className={left < 0 ? 'over' : 'muted'}>
                  {left >= 0 ? `还剩 ${Math.ceil(left)} 分钟` : left > -1 ? '时间到了' : `已超出 ${Math.floor(-left)} 分钟`}
                </span>
              )}
              <span className="spacer" />
              <button className="small" onClick={() => window.api.win.openMain('stop')}>
                结束
              </button>
            </div>
          </div>
        ) : current ? (
          <div className="float-now">
            <div className="float-label">按计划现在是</div>
            <div className="float-title">{current.title}</div>
            <div className="float-time">
              <span className="muted">
                {hhmm(current.startAt)}–{hhmm(current.endAt)}
              </span>
              <span className="spacer" />
              <button
                className="small"
                disabled={starting}
                onClick={() => void startPlan(current)}
              >
                ▶ 开始
              </button>
            </div>
          </div>
        ) : (
          <div className="float-now is-idle">
            <div className="float-label">现在没有在计时</div>
            {settings && <div className="muted">做完的事可以在「今天」的实际列里补录。</div>}
          </div>
        ))}

        {next && !smart.pending && (
          <div className="float-next">
            <span className="muted">下一件</span>
            <span className="float-next-title">{next.title}</span>
            <span className="muted">{hhmm(next.startAt)}</span>
            <button className="small secondary" disabled={starting} aria-label={`提前开始「${next.title}」`} onClick={() => void startPlan(next)}>
              提前开始
            </button>
          </div>
        )}

        {!smart.pending && (
          <div className="float-picker">
            <button type="button" className="float-picker-toggle" aria-expanded={pickerOpen} aria-controls={pickerId}
              onClick={() => setPickerOpen((open) => !open)}>
              <span>{running ? '切换任务' : '选择任务开始'}</span><span aria-hidden>{pickerOpen ? '▾' : '▸'}</span>
            </button>
            <div id={pickerId} role="region" aria-label="任务和计划" className="float-picker-panel" hidden={!pickerOpen}>
              <input type="search" aria-label="筛选任务或计划" placeholder="筛选任务或计划" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="float-picker-list">
                <h2>待安排</h2>
                {tasksForPicker.length ? (
                  <ul>{tasksForPicker.map((t) => (
                    <li key={t.id}>
                      <button type="button" className="float-picker-item" disabled={starting || running?.taskId === t.id}
                        aria-label={`${running?.taskId === t.id ? '计时中' : running ? '切换到' : '开始'}「${t.title}」`}
                        onClick={() => void start({ taskId: t.id })}>
                        <span title={t.title}>{t.title}</span><small>{running?.taskId === t.id ? '计时中' : categoryNames.get(t.categoryId ?? '')}</small>
                      </button>
                    </li>
                  ))}</ul>
                ) : <p className="muted">{query.trim() ? '没有匹配的待办' : '没有待安排的任务'}</p>}
                <h2>今日稍后计划</h2>
                {plansForPicker.length ? (
                  <ul>{plansForPicker.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="float-picker-item" disabled={starting} aria-label={`提前开始「${b.title}」，${hhmm(b.startAt)}`}
                        onClick={() => void startPlan(b)}>
                        <span title={b.title}>{b.title}</span><small>{hhmm(b.startAt)}</small>
                      </button>
                    </li>
                  ))}</ul>
                ) : <p className="muted">{query.trim() ? '没有匹配的计划' : '稍后没有计划'}</p>}
              </div>
            </div>
          </div>
        )}

        {captureExpanded ? (
          <form
            className="float-capture is-expanded"
            onSubmit={(e) => {
              e.preventDefault()
              capture()
            }}
          >
            <input
              ref={inputRef}
              aria-label="速记"
              placeholder={smart.busy ? 'AI 解析中…' : '输入内容后按回车保存'}
              value={text}
              disabled={smart.busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && closeCapture()}
            />
          </form>
        ) : (
          !smart.pending && (
            <button type="button" className="float-hint" onClick={() => setCaptureExpanded(true)}>
              按 {settings?.hotkey || 'Alt+Shift+Space'} 快速记录
            </button>
          )
        )}
        {smart.pending && (
          <div className="float-confirm">
            <CaptureConfirm
              compact
              key={smart.pending.text}
              smart={smart}
              categories={categories}
              onCancel={() => {
                setText(smart.pending!.text)
                smart.cancel()
              }}
            />
          </div>
        )}
        {flash && <div role={flash.error ? 'alert' : 'status'} className={`float-flash ${flash.error ? 'is-error' : ''}`}>{flash.text}</div>}
      </div>
    </div>
  )
}
