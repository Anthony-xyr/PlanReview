import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Category, PlanBlock, Settings, TimeEntry } from '@shared/types'
import { dayOf, dayRange, formatElapsed, hhmm } from '@shared/time'
import { remainingMin } from '@shared/session'
import { ReminderCard } from '../components/ReminderCard'
import { errorText } from '../ui'
import { reminderActions, useReminder } from '../reminderActions'
import { CaptureConfirm, useSmartCapture } from '../capture'

/**
 * 悬浮窗：显示当前事项和计时、下一件事、速记框。
 * 窗口高度跟随内容。
 */
export function FloatApp() {
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [next, setNext] = useState<PlanBlock | null>(null)
  const [current, setCurrent] = useState<PlanBlock | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null)
  const [, setTick] = useState(0)
  const [captureExpanded, setCaptureExpanded] = useState(false)
  const reminder = useReminder()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const [r, s, cats] = await Promise.all([window.api.entries.running(), window.api.settings.get(), window.api.categories.list()])
    setCategories(cats.filter((c) => !c.archived))
    const now = new Date()
    const { end } = dayRange(dayOf(now, s.dayStartHour), s.dayStartHour)
    const blocks = await window.api.plan.list(now.toISOString(), end.toISOString())
    const pending = blocks.filter((b) => b.taskStatus !== 'done')
    setRunning(r)
    setSettings(s)
    setCurrent(pending.find((b) => new Date(b.startAt) <= now) ?? null)
    setNext(pending.find((b) => new Date(b.startAt) > now) ?? null)
  }, [])

  useEffect(() => {
    load()
    const offData = window.api.events.onDataChanged(load)
    const offFocus = window.api.onFocusCapture(() => {
      setCaptureExpanded(true)
      setTimeout(() => inputRef.current?.focus(), 50)
    })
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    const reload = setInterval(load, 60_000)
    return () => {
      offData()
      offFocus()
      clearInterval(t)
      clearInterval(reload)
    }
  }, [load])

  // 窗口高度跟随内容
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => window.api.win.resizeFloat(el.getBoundingClientRect().height + 2))
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

  const left = running ? remainingMin(running) : null

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
            <span className="elapsed">{formatElapsed(Date.now() - new Date(running.startAt).getTime())}</span>
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
              onClick={() =>
                run(() =>
                  window.api.entries.start({ taskId: current.taskId, title: current.taskId ? undefined : current.title, categoryId: current.categoryId, planBlockId: current.id })
                )
              }
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
          <div className="float-hint" onClick={() => setCaptureExpanded(true)}>
            按 {settings?.hotkey || 'Alt+Shift+Space'} 快速记录
          </div>
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
      {flash && <div className={`float-flash ${flash.error ? 'is-error' : ''}`}>{flash.text}</div>}
    </div>
  )
}
