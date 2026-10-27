import { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, PlanBlock, Settings, StartTimerInput, Task, TimeEntry } from '@shared/types'
import type { Mutate } from '../ui'
import { formatMinutes } from '@shared/format'
import {
  addMinutes,
  clamp,
  clockToOffset,
  dayOf,
  dayRange,
  hhmm,
  layoutLanes,
  minutesFrom,
  overlapMin,
  shiftDay,
  snap
} from '@shared/time'
import { BlockDialog, type BlockDraft } from './BlockDialog'
import { ResurfacePanel } from './Resurface'

const PX_PER_MIN = 1.1
const DAY_MIN = 1440
const DRAG_THRESHOLD = 4

interface Props {
  settings: Settings
  categories: Category[]
  version: number
  mutate: Mutate
  running: TimeEntry | null
  onStartTimer: (input: StartTimerInput) => void
  onOpenInbox: () => void
  onOpenReview: (day: string) => void
  onOpenPlanner: (day: string) => void
  notify: (text: string, error?: boolean) => void
}

type Kind = 'plan' | 'entry'

/** 正在进行的鼠标操作：在空白处拖出新时段、移动、拉伸 */
type Drag =
  | { op: 'create'; kind: Kind; anchor: number; cur: number }
  | { op: 'move' | 'resize'; kind: Kind; id: string; start: number; end: number; grab: number; moved: boolean }

export function TodayView({ settings, categories, version, mutate, running, onStartTimer, onOpenInbox, onOpenReview, onOpenPlanner, notify }: Props) {
  const [day, setDay] = useState(() => dayOf(new Date(), settings.dayStartHour))
  const [blocks, setBlocks] = useState<PlanBlock[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [draft, setDraft] = useState<BlockDraft | null>(null)
  const [surfaced, setSurfaced] = useState<Set<string>>(new Set())
  const [aiReady, setAiReady] = useState(false)

  useEffect(() => {
    window.api.ai.getConfig().then((c) => setAiReady(c.enabled && !!c.baseUrl && !!c.model))
  }, [version])
  const [now, setNow] = useState(() => new Date())
  const gridRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  const { start: dayStart, end: dayEnd } = useMemo(() => dayRange(day, settings.dayStartHour), [day, settings.dayStartHour])
  const isToday = day === dayOf(now, settings.dayStartHour)
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const from = dayStart.toISOString()
    const to = dayEnd.toISOString()
    Promise.all([
      window.api.plan.list(from, to),
      window.api.entries.list(from, to),
      window.api.tasks.list({ status: ['inbox', 'active'] })
    ]).then(([b, e, t]) => {
      setBlocks(b)
      setEntries(e)
      setTasks(t)
    })
  }, [dayStart, dayEnd, version, running?.id])

  // 首次打开滚到当前时间附近
  useEffect(() => {
    if (scrolled.current || !gridRef.current) return
    scrolled.current = true
    const target = isToday ? minutesFrom(dayStart, now) - 90 : 180
    gridRef.current.parentElement!.scrollTop = Math.max(0, target * PX_PER_MIN)
  })

  // ---------- 统计 ----------

  const nowMin = clamp(minutesFrom(dayStart, now), 0, DAY_MIN)
  const sleepMin = clockToOffset(settings.sleepStart, settings.dayStartHour)
  const sleepEndMin = clockToOffset(settings.sleepEnd, settings.dayStartHour)
  const span = (s: string, e: string | null) => [minutesFrom(dayStart, s), e ? minutesFrom(dayStart, e) : nowMin] as const

  const planned = blocks.reduce((sum, b) => sum + overlapMin(...span(b.startAt, b.endAt), 0, DAY_MIN), 0)
  const actual = entries.reduce((sum, e) => sum + overlapMin(...span(e.startAt, e.endAt), 0, DAY_MIN), 0)
  // 现在到睡眠窗口之间，还没被计划占用的时间
  const freeUntilSleep = isToday
    ? Math.max(0, sleepMin - nowMin) - blocks.reduce((s, b) => s + overlapMin(...span(b.startAt, b.endAt), nowMin, sleepMin), 0)
    : null

  // 计划 vs 实际（按任务）
  const plannedByTask = new Map<string, number>()
  for (const b of blocks) if (b.taskId) plannedByTask.set(b.taskId, (plannedByTask.get(b.taskId) ?? 0) + overlapMin(...span(b.startAt, b.endAt), 0, DAY_MIN))
  const scheduledIds = new Set(blocks.map((b) => b.taskId).filter(Boolean))
  // 只列正式待办，收件箱的先整理再排；找回区已经列出来的不在「待安排」里重复
  const unscheduled = tasks.filter((t) => t.status === 'active' && !scheduledIds.has(t.id) && !surfaced.has(t.id))

  // ---------- 拖拽 ----------

  const minuteAt = (clientY: number) => {
    const rect = gridRef.current!.getBoundingClientRect()
    return clamp((clientY - rect.top) / PX_PER_MIN, 0, DAY_MIN)
  }

  // 拖拽状态同时存在 ref 里：pointerup 可能在界面重绘之前到达，必须读到最新值
  const dragRef = useRef<Drag | null>(null)
  const dragging = drag !== null

  const updateDrag = (d: Drag | null) => {
    dragRef.current = d
    setDrag(d)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const m = minuteAt(e.clientY)
      if (d.op === 'create') return updateDrag({ ...d, cur: m })
      const moved = d.moved || Math.abs((m - d.grab) * PX_PER_MIN) > DRAG_THRESHOLD
      if (d.op === 'move') {
        const len = d.end - d.start
        const s = clamp(d.start + snap(m - d.grab), 0, DAY_MIN - len)
        return updateDrag({ ...d, moved, grab: d.grab + (s - d.start), start: s, end: s + len })
      }
      updateDrag({ ...d, moved, end: clamp(snap(m), d.start + 15, DAY_MIN) })
    }
    const onUp = () => {
      const d = dragRef.current
      updateDrag(null)
      if (d) commitDrag(d)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  const commitDrag = (d: Drag) => {
    if (d.op === 'create') {
      let [a, b] = [d.anchor, d.cur].sort((x, y) => x - y)
      if (b - a < 10) {
        // 单击：默认一小时
        a = snap(a, 30)
        b = a + 60
      } else {
        a = snap(a)
        b = snap(b)
      }
      b = clamp(b, a + 15, DAY_MIN)
      if (d.kind === 'entry') {
        b = Math.min(b, Math.floor(nowMin))
        if (b - a < 1) return
      }
      setDraft({ kind: d.kind, startAt: addMinutes(dayStart, a).toISOString(), endAt: addMinutes(dayStart, b).toISOString() })
      return
    }
    if (!d.moved) {
      // 没拖动就是点击：打开编辑
      const item = d.kind === 'plan' ? blocks.find((b) => b.id === d.id) : entries.find((e) => e.id === d.id)
      if (item) setDraft({ kind: d.kind, id: item.id, taskId: item.taskId, title: item.title, categoryId: item.categoryId, startAt: item.startAt, endAt: item.endAt ?? null })
      return
    }
    const patch = { startAt: addMinutes(dayStart, d.start).toISOString(), endAt: addMinutes(dayStart, d.end).toISOString() }
    mutate<unknown>(() => (d.kind === 'plan' ? window.api.plan.update(d.id, patch) : window.api.entries.update(d.id, patch)))
  }

  const beginCreate = (kind: Kind) => (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const m = minuteAt(e.clientY)
    if (kind === 'entry' && m > nowMin) return
    updateDrag({ op: 'create', kind, anchor: m, cur: m })
  }

  const beginItem = (kind: Kind, id: string, s: number, en: number, op: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    updateDrag({ op, kind, id, start: s, end: en, grab: minuteAt(e.clientY), moved: false })
  }

  // ---------- 放置任务（从左侧列表拖进计划列） ----------

  const onDropTask = (e: React.DragEvent) => {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/task-id')
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const a = snap(minuteAt(e.clientY))
    const len = clamp(task.estimateMin ? task.estimateMin - task.spentMin : 60, 30, 120)
    mutate(() =>
      window.api.plan.create({ taskId, startAt: addMinutes(dayStart, a).toISOString(), endAt: addMinutes(dayStart, Math.min(a + len, DAY_MIN)).toISOString() })
    )
  }

  // ---------- 渲染 ----------

  const hours = Array.from({ length: 24 }, (_, i) => (settings.dayStartHour + i) % 24)

  const renderColumn = (kind: Kind) => {
    const items =
      kind === 'plan'
        ? blocks.map((b) => ({ id: b.id, title: b.title, cat: b.categoryId, s: minutesFrom(dayStart, b.startAt), e: minutesFrom(dayStart, b.endAt), done: b.taskStatus === 'done', live: false, taskId: b.taskId, course: !!b.courseId, loc: b.location }))
        : entries.map((en) => ({ id: en.id, title: en.title, cat: en.categoryId, s: minutesFrom(dayStart, en.startAt), e: en.endAt ? minutesFrom(dayStart, en.endAt) : nowMin, done: false, live: !en.endAt, taskId: en.taskId, course: false, loc: '' }))

    // 拖动中的条目用临时位置显示
    const shown = items.map((it) =>
      drag && drag.op !== 'create' && drag.kind === kind && drag.id === it.id ? { ...it, s: drag.start, e: drag.end } : it
    )
    const lanes = layoutLanes(shown.map((it) => ({ start: it.s, end: it.e })))
    const ghost =
      drag?.op === 'create' && drag.kind === kind
        ? [Math.min(drag.anchor, drag.cur), Math.max(drag.anchor, drag.cur)]
        : null

    return (
      <div
        className={`col col-${kind}`}
        onPointerDown={beginCreate(kind)}
        onDragOver={kind === 'plan' ? (e) => e.preventDefault() : undefined}
        onDrop={kind === 'plan' ? onDropTask : undefined}
        aria-label={kind === 'plan' ? '计划列' : '实际列'}
      >
        {kind === 'entry' && isToday && (
          <div className="future-mask" style={{ top: nowMin * PX_PER_MIN }} title="还没到的时间不能补录" />
        )}
        {shown.map((it, i) => {
          const s = clamp(it.s, 0, DAY_MIN)
          const e = clamp(it.e, 0, DAY_MIN)
          const c = it.cat ? catById.get(it.cat) : undefined
          const { lane, lanes: n } = lanes[i]
          const short = (e - s) * PX_PER_MIN < 34
          return (
            <div
              key={it.id}
              className={`block block-${kind} ${it.done ? 'is-done' : ''} ${it.live ? 'is-live' : ''} ${short ? 'is-short' : ''} ${it.course ? 'is-course' : ''}`}
              style={{
                top: s * PX_PER_MIN,
                height: Math.max(12, (e - s) * PX_PER_MIN),
                left: `calc(${(lane / n) * 100}% + 2px)`,
                width: `calc(${100 / n}% - 4px)`,
                ['--c' as string]: c?.color ?? 'var(--faint)'
              }}
              onPointerDown={it.live ? undefined : beginItem(kind, it.id, s, e, 'move')}
              title={`${it.title}  ${hhmm(addMinutes(dayStart, s))}–${hhmm(addMinutes(dayStart, e))}`}
            >
              <div className="block-title">
                {it.done && '✓ '}
                {it.title}
              </div>
              {!short && (
                <div className="block-time">
                  {hhmm(addMinutes(dayStart, s))}–{it.live ? '进行中' : hhmm(addMinutes(dayStart, e))} · {formatMinutes(Math.round(e - s))}
                  {it.loc && <span className="block-loc"> · {it.loc}</span>}
                </div>
              )}
              {kind === 'plan' && !short && !it.course && (
                <button
                  className="block-start"
                  aria-label={`开始计时「${it.title}」`}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={() => onStartTimer({ taskId: it.taskId, title: it.taskId ? undefined : it.title, categoryId: it.cat, planBlockId: it.id })}
                >
                  ▶
                </button>
              )}
              {!it.live && <div className="resize" onPointerDown={beginItem(kind, it.id, s, e, 'resize')} aria-hidden />}
            </div>
          )
        })}
        {ghost && (
          <div className="block ghost" style={{ top: ghost[0] * PX_PER_MIN, height: Math.max(8, (ghost[1] - ghost[0]) * PX_PER_MIN) }}>
            {hhmm(addMinutes(dayStart, snap(ghost[0])))}–{hhmm(addMinutes(dayStart, snap(ghost[1])))}
          </div>
        )}
      </div>
    )
  }

  const weekday = '日一二三四五六'[new Date(`${day}T12:00`).getDay()]

  return (
    <div className="today">
      <header className="page-head">
        <div className="day-nav">
          <button className="secondary icon" aria-label="前一天" onClick={() => setDay(shiftDay(day, -1))}>
            ‹
          </button>
          <h1>
            {isToday ? '今天' : day.slice(5).replace('-', '月') + '日'}
            <span className="sub">
              {day} 周{weekday}
            </span>
          </h1>
          <button className="secondary icon" aria-label="后一天" onClick={() => setDay(shiftDay(day, 1))}>
            ›
          </button>
          {!isToday && (
            <button className="secondary" onClick={() => setDay(dayOf(new Date(), settings.dayStartHour))}>
              回到今天
            </button>
          )}
          {aiReady && day >= dayOf(now, settings.dayStartHour) && (
            <button onClick={() => onOpenPlanner(day)} title="AI 往剩下的空档里放待办，勾选后才写入">
              请 AI 排一下
            </button>
          )}
        </div>
        <div className="stats">
          <Stat label="计划" value={formatMinutes(Math.round(planned)) || '0m'} />
          <Stat label="实际" value={formatMinutes(Math.round(actual)) || '0m'} />
          {freeUntilSleep !== null && <Stat label="距睡眠窗口可安排" value={formatMinutes(Math.round(freeUntilSleep)) || '0m'} />}
        </div>
      </header>

      <div className="today-body">
        <aside className="pool" aria-label="待安排">
          {isToday && (
            <ResurfacePanel
              day={day}
              isToday={isToday}
              version={version}
              categories={categories}
              mutate={mutate}
              onStartTimer={onStartTimer}
              onOpenInbox={onOpenInbox}
              onOpenReview={onOpenReview}
              notify={notify}
              onSurfaced={setSurfaced}
            />
          )}
          <h2>待安排</h2>
          <p className="muted">把任务拖到右边的「计划」列。估时会扣掉已投入的部分。</p>
          {unscheduled.length === 0 && <p className="muted">待办里的任务都已经排进今天了。</p>}
          <ul className="pool-list">
            {unscheduled.map((t) => {
              const c = t.categoryId ? catById.get(t.categoryId) : undefined
              return (
                <li
                  key={t.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/task-id', t.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="pool-item"
                  style={{ ['--c' as string]: c?.color ?? 'var(--faint)' }}
                >
                  <div className="pool-title">{t.title}</div>
                  <div className="pool-meta">
                    {t.estimateMin != null && (
                      <span>
                        已投入 {formatMinutes(t.spentMin) || '0m'} / 估 {formatMinutes(t.estimateMin)}
                      </span>
                    )}
                    <button
                      className="link"
                      onClick={() => onStartTimer({ taskId: t.id })}
                      disabled={running?.taskId === t.id}
                    >
                      {running?.taskId === t.id ? '计时中' : '▶ 开始'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {plannedByTask.size > 0 && (
            <>
              <h2>今天的任务</h2>
              <ul className="compare">
                {[...plannedByTask].map(([id, plan]) => {
                  const b = blocks.find((x) => x.taskId === id)!
                  const act = entries.filter((e) => e.taskId === id).reduce((s, e) => s + overlapMin(...span(e.startAt, e.endAt), 0, DAY_MIN), 0)
                  const ratio = Math.min(1.5, act / plan)
                  return (
                    <li key={id}>
                      <div className="compare-head">
                        <span>{b.taskStatus === 'done' ? '✓ ' : ''}{b.title}</span>
                        <span className="muted">
                          {formatMinutes(Math.round(act)) || '0m'} / {formatMinutes(Math.round(plan))}
                        </span>
                      </div>
                      <div className="bar" aria-hidden>
                        <div className={`bar-fill ${act > plan ? 'over' : ''}`} style={{ width: `${(ratio / 1.5) * 100}%` }} />
                        <div className="bar-mark" style={{ left: `${100 / 1.5}%` }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </aside>

        <section className="timeline" aria-label="时间轴">
          <div className="timeline-head">
            <div className="gutter" />
            <div className="col-head">
              计划<span className="muted">在空白处拖动来安排</span>
            </div>
            <div className="col-head">
              实际<span className="muted">在空白处拖动来补录</span>
            </div>
          </div>
          <div className="timeline-scroll">
            <div className="grid" ref={gridRef} style={{ height: DAY_MIN * PX_PER_MIN }}>
              <div className="gutter">
                {hours.map((h, i) => (
                  <div key={i} className="hour-label" style={{ top: i * 60 * PX_PER_MIN }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                ))}
              </div>
              <div className="cols">
                {hours.map((_, i) => (
                  <div key={i} className="hour-line" style={{ top: i * 60 * PX_PER_MIN }} />
                ))}
                <SleepBand start={sleepMin} end={sleepEndMin} />
                {renderColumn('plan')}
                {renderColumn('entry')}
                {isToday && <div className="now-line" style={{ top: nowMin * PX_PER_MIN }} aria-label={`现在 ${hhmm(now)}`} />}
              </div>
            </div>
          </div>
        </section>
      </div>

      {draft && (
        <BlockDialog
          draft={draft}
          tasks={tasks}
          categories={categories}
          onClose={() => setDraft(null)}
          mutate={mutate}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

/** 睡眠窗口可能跨过一天的终点，此时分两段画 */
function SleepBand({ start, end }: { start: number; end: number }) {
  const segs: [number, number][] = start < end ? [[start, end]] : [[start, DAY_MIN], [0, end]]
  return (
    <>
      {segs.map(([a, b], i) => (
        <div key={i} className="sleep-band" style={{ top: a * PX_PER_MIN, height: (b - a) * PX_PER_MIN }}>
          {i === 0 && <span>睡眠窗口</span>}
        </div>
      ))}
    </>
  )
}
