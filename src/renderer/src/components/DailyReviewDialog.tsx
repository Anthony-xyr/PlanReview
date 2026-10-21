import { useEffect, useState } from 'react'
import type { Category, DayMood, DaySummary, OverrunReason, Task, TimeEntry } from '@shared/types'
import { OVERRUN_REASONS } from '@shared/types'
import { formatMinutes } from '@shared/format'
import { hhmm, shiftDay } from '@shared/time'
import { Dialog, type Mutate } from '../ui'

interface Props {
  /** 复盘哪一天 */
  day: string
  categories: Category[]
  mutate: Mutate
  onClose: () => void
  onSwitchDay: (day: string) => void
}

const MOODS: { value: DayMood; label: string }[] = [
  { value: 1, label: '很糟' },
  { value: 2, label: '不太好' },
  { value: 3, label: '一般' },
  { value: 4, label: '不错' },
  { value: 5, label: '很好' }
]

const fm = (m: number) => formatMinutes(m) || '0m'

/**
 * 每日快速复盘：2–3 分钟。
 * 先看数字，再补标超时原因，最后写一两句话、选好明天先做的事。
 */
export function DailyReviewDialog({ day, categories, mutate, onClose, onSwitchDay }: Props) {
  const [s, setS] = useState<DaySummary | null>(null)
  const [open, setOpen] = useState<Task[]>([])
  const [mood, setMood] = useState<DayMood | null>(null)
  const [note, setNote] = useState('')
  const [tomorrow, setTomorrow] = useState<string>('')
  const [reasons, setReasons] = useState<Record<string, OverrunReason>>({})
  const [saved, setSaved] = useState(false)
  const catById = new Map(categories.map((c) => [c.id, c]))

  useEffect(() => {
    setS(null)
    setSaved(false)
    setReasons({})
    Promise.all([window.api.review.summary(day), window.api.tasks.list({ status: 'active' })]).then(([sum, tasks]) => {
      setS(sum)
      setOpen(tasks)
      setMood(sum.review?.mood ?? null)
      setNote(sum.review?.note ?? '')
      setTomorrow(sum.review?.tomorrowTaskId ?? '')
    })
  }, [day])

  const save = async () => {
    const ok = await mutate(async () => {
      for (const [id, r] of Object.entries(reasons)) await window.api.entries.setReason(id, r)
      return window.api.review.save(day, { mood, note, tomorrowTaskId: tomorrow || null })
    })
    if (ok) setSaved(true)
  }

  const nav = (
    <div className="dr-nav">
      <button className="secondary icon" aria-label="前一天" onClick={() => onSwitchDay(shiftDay(day, -1))}>
        ‹
      </button>
      <span>{day}</span>
      <button className="secondary icon" aria-label="后一天" onClick={() => onSwitchDay(shiftDay(day, 1))}>
        ›
      </button>
    </div>
  )

  if (!s)
    return (
      <Dialog title="今日复盘" onClose={onClose}>
        {nav}
        <p className="muted">正在汇总…</p>
      </Dialog>
    )

  if (saved)
    return (
      <Dialog title="今日复盘" onClose={onClose}>
        <p className="dialog-lead">记好了。{tomorrow && '明天打开时会先看到你选的那件事。'}</p>
        <div className="dialog-actions">
          <button autoFocus onClick={onClose}>
            关闭
          </button>
        </div>
      </Dialog>
    )

  const empty = s.plannedMin === 0 && s.actualMin === 0
  const maxBar = Math.max(1, ...s.byCategory.map((c) => Math.max(c.plannedMin, c.actualMin)))

  return (
    <Dialog title="今日复盘" onClose={onClose}>
      {nav}

      {empty ? (
        <p className="dialog-lead">这天没有计划也没有记录。可以只写一两句感受。</p>
      ) : (
        <>
          <div className="dr-numbers">
            <div>
              <div className="stat-value">{fm(s.plannedMin)}</div>
              <div className="stat-label">计划</div>
            </div>
            <div>
              <div className="stat-value">{fm(s.actualMin)}</div>
              <div className="stat-label">实际</div>
            </div>
            <div>
              <div className="stat-value">{s.completed.length}</div>
              <div className="stat-label">完成</div>
            </div>
          </div>

          {s.byCategory.length > 0 && (
            <ul className="dr-cats" aria-label="按大类">
              {s.byCategory.map((c) => {
                const cat = c.categoryId ? catById.get(c.categoryId) : undefined
                return (
                  <li key={c.categoryId ?? 'none'} style={{ ['--c' as string]: cat?.color ?? '#8a8478' }}>
                    <span className="dr-cat-name">{cat?.name ?? '未分类'}</span>
                    <span className="dr-bars" aria-hidden>
                      <span className="dr-bar plan" style={{ width: `${(c.plannedMin / maxBar) * 100}%` }} />
                      <span className="dr-bar act" style={{ width: `${(c.actualMin / maxBar) * 100}%` }} />
                    </span>
                    <span className="muted">
                      {fm(c.actualMin)} / {fm(c.plannedMin)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {(s.skipped.length > 0 || s.unplanned.length > 0) && (
            <div className="dr-diff">
              {s.skipped.length > 0 && (
                <div>
                  <h3>计划了没动</h3>
                  <ul>
                    {s.skipped.map((b) => (
                      <li key={b.id}>
                        {b.title} <span className="muted">{hhmm(b.startAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {s.unplanned.length > 0 && (
                <div>
                  <h3>临时做的</h3>
                  <ul>
                    {s.unplanned.map((e) => (
                      <li key={e.id}>
                        {e.title} <span className="muted">{fm(minutes(e))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {s.needReason.length > 0 && (
            <fieldset className="dr-reasons">
              <legend>这几次比原定久了不少，主要是因为？（可以跳过）</legend>
              {s.needReason.map(({ entry: e, plannedMin }) => (
                <div key={e.id} className="dr-reason-row">
                  <span>
                    {e.title} <span className="muted">做了 {fm(minutes(e))}，原定 {fm(plannedMin)}</span>
                  </span>
                  <span className="reasons">
                    {OVERRUN_REASONS.map((r) => (
                      <label key={r.value} className={`reason ${reasons[e.id] === r.value ? 'on' : ''}`} title={r.hint}>
                        <input
                          type="radio"
                          name={`r-${e.id}`}
                          checked={reasons[e.id] === r.value}
                          onChange={() => setReasons({ ...reasons, [e.id]: r.value })}
                        />
                        <span>{r.label}</span>
                      </label>
                    ))}
                  </span>
                </div>
              ))}
            </fieldset>
          )}
        </>
      )}

      <fieldset className="dr-mood">
        <legend>整体感觉</legend>
        {MOODS.map((m) => (
          <label key={m.value} className={`reason ${mood === m.value ? 'on' : ''}`}>
            <input type="radio" name="mood" checked={mood === m.value} onChange={() => setMood(m.value)} />
            <span>{m.label}</span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span>一两句话：做得好的、想调整的</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：下午犯困，难的放上午" />
      </label>

      <label className="field">
        <span>明天最想先做的一件事</span>
        <select value={tomorrow} onChange={(e) => setTomorrow(e.target.value)}>
          <option value="">先不选</option>
          {open.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>

      <div className="dialog-actions">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button onClick={save}>保存</button>
      </div>
    </Dialog>
  )
}

function minutes(e: TimeEntry): number {
  const end = e.endAt ? new Date(e.endAt).getTime() : Date.now()
  return Math.round((end - new Date(e.startAt).getTime()) / 60_000)
}
