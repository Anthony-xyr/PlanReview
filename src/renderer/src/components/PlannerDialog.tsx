import { useState } from 'react'
import type { PlanSuggestion } from '@shared/types'
import { hhmm } from '@shared/time'
import { Dialog, errorText, type Mutate } from '../ui'

interface Props {
  day: string
  mutate: Mutate
  onClose: () => void
  onDone: (msg: string) => void
}

/** 请 AI 给今天剩下的时间排一个草稿；用户勾选后才写进时间轴 */
export function PlannerDialog({ day, mutate, onClose, onDone }: Props) {
  const [hint, setHint] = useState('')
  const [plan, setPlan] = useState<PlanSuggestion | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      const p = await window.api.planner.suggest(day, hint)
      setPlan(p)
      setPicked(new Set(p.blocks.map((_, i) => i)))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const accept = async () => {
    if (!plan) return
    const blocks = plan.blocks.filter((_, i) => picked.has(i))
    const r = await mutate(() => window.api.planner.accept(day, blocks))
    if (r) onDone(`已排进 ${r.created} 个时段，可以在时间轴上拖动调整`)
  }

  const toggle = (i: number) => {
    const n = new Set(picked)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    setPicked(n)
  }

  return (
    <Dialog title="请 AI 排一下" onClose={onClose}>
      {!plan ? (
        <>
          <p className="dialog-lead">AI 只会往今天剩下的空档里放待办任务，不动已有安排。给出的是草稿，勾选后才会写进时间轴。</p>
          <label className="field">
            <span>有什么要求（可选）</span>
            <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="比如：晚上 9 点后留给打游戏；先做实验报告" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button onClick={ask} disabled={busy}>
              {busy ? '正在排…' : '开始'}
            </button>
          </div>
        </>
      ) : (
        <>
          {plan.blocks.length === 0 ? (
            <p className="dialog-lead">没有可以排的。</p>
          ) : (
            <ul className="plan-list">
              {plan.blocks.map((b, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                    <span className="plan-time">
                      {hhmm(b.startAt)}–{hhmm(b.endAt)}
                    </span>
                    <span className="plan-title">
                      {b.title}
                      {!b.taskId && <span className="badge">保留时段</span>}
                    </span>
                  </label>
                  {b.reason && <div className="sug-evidence">{b.reason}</div>}
                </li>
              ))}
            </ul>
          )}
          {plan.notes.map((n, i) => (
            <p key={i} className="muted">
              {n}
            </p>
          ))}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="link" onClick={() => setPlan(null)}>
              重新排
            </button>
            <span className="spacer" />
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button onClick={accept} disabled={picked.size === 0}>
              排进时间轴（{picked.size}）
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
