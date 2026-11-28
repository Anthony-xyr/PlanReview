import { useEffect, useState } from 'react'
import type { CaptureHabit, PlanReplan, PlanSuggestion } from '@shared/types'
import { MAX_HABIT_CHARS, MAX_HABITS } from '@shared/types'
import { hhmm } from '@shared/time'
import { Dialog, errorText, type Mutate } from '../ui'
import { HabitsDialog } from './HabitsDialog'
import './PlannerDialog.css'

interface Props {
  day: string
  mutate: Mutate
  onClose: () => void
  onDone: (msg: string) => void
}

/**
 * 请 AI 给今天剩下的时间排一个草稿；用户勾选后才写进时间轴。
 * 排得不合习惯可以「纠正」：写一句哪里不对，AI 重排，并提出一条排程习惯，排进时间轴时才记下。
 */
export function PlannerDialog({ day, mutate, onClose, onDone }: Props) {
  const [hint, setHint] = useState('')
  const [plan, setPlan] = useState<PlanSuggestion | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [habits, setHabits] = useState<CaptureHabit[]>([])
  const [showHabits, setShowHabits] = useState(false)
  // 纠正：历次说明、最近一次 AI 提出的习惯
  const [correcting, setCorrecting] = useState(false)
  const [note, setNote] = useState('')
  const [feedback, setFeedback] = useState<string[]>([])
  const [sug, setSug] = useState<PlanReplan | null>(null)
  const [remember, setRemember] = useState(true)
  const [habitText, setHabitText] = useState('')

  const loadHabits = () => window.api.habits.list('planner').then(setHabits).catch((e) => setError(errorText(e)))
  useEffect(() => {
    loadHabits()
  }, [])
  const enabled = habits.filter((h) => h.enabled)
  const byId = new Map(habits.map((h) => [h.id, h]))

  const show = (p: PlanSuggestion) => {
    setPlan(p)
    setPicked(new Set(p.blocks.map((_, i) => i)))
  }

  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      show(await window.api.planner.suggest(day, hint))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const replan = async () => {
    const n = note.trim()
    if (!plan || !n || busy) return
    setBusy(true)
    setError(null)
    try {
      const all = [...feedback, n].slice(-5)
      const r = await window.api.planner.replan(day, hint, plan.blocks, all)
      show(r)
      setFeedback(all)
      setNote('')
      setCorrecting(false)
      setSug(r)
      setRemember(true)
      setHabitText(r.habit)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // 重新排：回到第一步，这次的纠正和习惯建议都作废
  const restart = () => {
    setPlan(null)
    setFeedback([])
    setSug(null)
    setCorrecting(false)
    setNote('')
  }

  const habitToSave = sug?.habit && remember && habitText.trim() ? { text: habitText.trim(), replacesId: sug.replacesId } : null
  const replaced = habitToSave?.replacesId ? byId.get(habitToSave.replacesId) : undefined

  const atLimit = !!habitToSave && !replaced && habits.length >= MAX_HABITS && !habits.some((h) => h.text === habitToSave.text)
  const accept = async () => {
    if (!plan || busy || atLimit) return
    setBusy(true)
    setError(null)
    try {
      const blocks = plan.blocks.filter((_, i) => picked.has(i))
      const r = await mutate(() => window.api.planner.accept(day, blocks, {
        habitIds: plan.habitIds,
        habit: habitToSave ? { ...habitToSave, example: feedback.join('；').slice(0, 200) } : undefined
      }))
      if (r) onDone(`已排进 ${r.created} 个时段${habitToSave ? (habitToSave.replacesId ? '，排程习惯已更新' : '，也记住了这个排程习惯') : ''}，可以在时间轴上拖动调整`)
      else setError('未能排进时间轴，草稿仍保留，请按提示重试')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (i: number) => {
    const n = new Set(picked)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    setPicked(n)
  }

  const habitsLink = (
    <button type="button" className="link" onClick={() => setShowHabits(true)}>
      排程习惯（{enabled.length} 条）
    </button>
  )
  const used = plan ? plan.habitIds.map((id) => byId.get(id)?.text).filter(Boolean) : []

  return (
    <Dialog title="请 AI 排一下" onClose={() => { if (!busy) onClose() }}>
      {!plan ? (
        <>
          <p className="dialog-lead">AI 只会往今天剩下的空档里放待办任务，不动已有安排。给出的是草稿，勾选后才会写进时间轴。</p>
          <label className="field">
            <span>有什么要求（可选）</span>
            <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="比如：晚上 9 点后留给打游戏；先做实验报告" />
          </label>
          <p className="muted">
            {enabled.length ? '会照你的排程习惯来排，这次的要求优先。' : '固定的安排习惯（吃饭时间、先读论文再复现）可以记成排程习惯，每次都会照着排。'} {habitsLink}
          </p>
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
          {feedback.length > 0 && <p className="dialog-lead">按你的纠正重新排好了。</p>}
          <fieldset className="plan-fields" disabled={busy}>
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
          </fieldset>
          {plan.notes.map((n, i) => (
            <p key={i} className="muted">
              {n}
            </p>
          ))}
          {used.length > 0 && <p className="muted">这次参考了：{used.map((t) => `「${t}」`).join('、')}</p>}

          {sug && (
            <div className="cc-habit">
              {sug.habit ? (
                <>
                  <label className="check">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    {sug.replacesId && byId.has(sug.replacesId) ? '更新这条排程习惯，以后都这样排' : '记住这个排程习惯，以后都这样排'}
                  </label>
                  <input aria-label="要记住的排程习惯" maxLength={MAX_HABIT_CHARS} value={habitText} disabled={!remember} onChange={(e) => setHabitText(e.target.value)} />
                  {replaced && <p className="muted cc-replaces">会替换：{replaced.text}</p>}
                  <p className="muted">点「排进时间轴」时才会记下，之后可以在 {habitsLink} 里修改。</p>
                </>
              ) : (
                <p className="muted">这次的纠正只针对今天，不会记成习惯。</p>
              )}
            </div>
          )}

          {correcting && (
            <div className="cc-correct">
              <label className="field">
                <span>哪里不合你的习惯？</span>
                <textarea
                  autoFocus
                  rows={2}
                  maxLength={300}
                  placeholder="例如：18:00–19:00 要吃晚饭；论文阅读要排在论文复现前面"
                  value={note}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    // 回车重排，Shift+回车换行
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      replan()
                    }
                    if (e.key === 'Escape') {
                      // 先收起纠正框，不关掉整个对话框
                      e.preventDefault()
                      e.stopPropagation()
                      setCorrecting(false)
                    }
                  }}
                />
              </label>
              {feedback.length > 0 && <p className="muted">会连同最近 {feedback.length} 次的说明一起发给 AI。</p>}
              <div className="cc-correct-actions">
                <button type="button" className="link" disabled={busy} onClick={() => (setCorrecting(false), setNote(''))}>
                  收起
                </button>
                <button type="button" disabled={!note.trim() || busy} onClick={replan}>
                  {busy ? '正在重排…' : '重新排'}
                </button>
              </div>
            </div>
          )}

          {atLimit && <p className="muted" role="status">排程习惯已达到 {MAX_HABITS} 条，请取消勾选这次习惯，或先管理已有习惯。</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="link" disabled={busy} onClick={restart}>
              从头再排
            </button>
            {!correcting && (
              <button className="link" disabled={busy} onClick={() => setCorrecting(true)}>
                纠正
              </button>
            )}
            <span className="spacer" />
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button onClick={accept} disabled={picked.size === 0 || busy || atLimit}>
              排进时间轴（{picked.size}）
            </button>
          </div>
        </>
      )}
      {showHabits && (
        <HabitsDialog
          kind="planner"
          onClose={() => {
            setShowHabits(false)
            loadHabits()
          }}
        />
      )}
    </Dialog>
  )
}
