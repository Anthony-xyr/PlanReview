import { useEffect, useState } from 'react'
import { OVERRUN_REASONS, type OverrunReason, type Task, type TimeEntry } from '@shared/types'
import { Dialog } from '../ui'
import { formatElapsed, hhmm } from '@shared/time'
import { isOverrun, remainingMin } from '@shared/session'
import { formatMinutes } from '@shared/format'

export function useTick(ms: number) {
  const [, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

/** 顶部常驻的计时条：任何页面都能看到正在做什么、还剩多久 */
export function TimerBar({ running, onStop, onExtend }: { running: TimeEntry; onStop: () => void; onExtend: () => void }) {
  useTick(1000)
  const left = remainingMin(running)
  const over = left !== null && left < 0
  return (
    <div className={`timerbar ${over ? 'is-over' : ''}`} role="status">
      <span className="pulse" aria-hidden />
      <span>正在进行</span>
      <strong className="timer-title">{running.title}</strong>
      <span className="elapsed">{formatElapsed(Date.now() - new Date(running.startAt).getTime())}</span>
      {left !== null && (
        <span className="timer-left">
          {over ? (left > -1 ? '本次时间到了' : `超出本次 ${Math.floor(-left)} 分钟`) : `本次到 ${hhmm(running.targetEndAt!)}，还剩 ${Math.ceil(left)} 分钟`}
        </span>
      )}
      <button className="secondary" onClick={onExtend}>
        延长
      </button>
      <button onClick={onStop}>结束本次</button>
    </div>
  )
}

interface StopProps {
  running: TimeEntry
  task: Task | null
  overrunRatio: number
  onConfirm: (input: { nextStep?: string; complete: boolean; overrunReason: OverrunReason | null }) => void
  onClose: () => void
}

/** 结束本次投入：完成任务、写下一步、超时原因都是可选的 */
export function StopDialog({ running, task, overrunRatio, onConfirm, onClose }: StopProps) {
  const [nextStep, setNextStep] = useState(task?.nextStep ?? '')
  const [complete, setComplete] = useState(false)
  const [reason, setReason] = useState<OverrunReason | null>(null)
  useTick(1000)
  const elapsed = Date.now() - new Date(running.startAt).getTime()
  const overrun = isOverrun(running, overrunRatio)

  return (
    <Dialog title="结束本次投入" onClose={onClose}>
      <p className="dialog-lead">
        「{running.title}」这次做了 {formatElapsed(elapsed)}
        {running.plannedMin ? `，本次原定 ${formatMinutes(running.plannedMin)}` : ''}
        {running.extendedMin ? `，延长过 ${formatMinutes(running.extendedMin)}` : ''}。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm({ nextStep: task ? nextStep : undefined, complete, overrunReason: overrun ? reason : null })
        }}
      >
        {overrun && (
          <fieldset className="reasons">
            <legend>比原定久了不少，主要是因为？（可以跳过）</legend>
            {OVERRUN_REASONS.map((r) => (
              <label key={r.value} className={`reason ${reason === r.value ? 'on' : ''}`}>
                <input type="radio" name="reason" checked={reason === r.value} onChange={() => setReason(r.value)} />
                <span>{r.label}</span>
                {r.hint && <small>{r.hint}</small>}
              </label>
            ))}
            <p className="muted">这只用来让之后的复盘更有依据，不是在评判你。</p>
          </fieldset>
        )}
        {task && (
          <>
            <label className="field">
              <span>下一步（留给下次的自己，可不填）</span>
              <input autoFocus value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="比如：从第 3 题开始" />
            </label>
            <label className="check">
              <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
              这个任务已经全部完成
            </label>
            <p className="muted">不勾选的话，任务会留在待办里，下次接着做。</p>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            继续计时
          </button>
          <button type="submit" autoFocus={!task}>
            结束本次
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** 延长：选一个时长，或者取消本次目标 */
export function ExtendDialog({ step, onExtend, onClear, onClose }: { step: number; onExtend: (min: number) => void; onClear: () => void; onClose: () => void }) {
  const options = [...new Set([step, 15, 30, 60])].sort((a, b) => a - b)
  return (
    <Dialog title="延长本次" onClose={onClose}>
      <p className="dialog-lead">只推后这一次的结束时间，原来的计划不会被改掉。</p>
      <div className="choice-row">
        {options.map((m) => (
          <button key={m} className="secondary" onClick={() => onExtend(m)}>
            +{m} 分钟
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="link" onClick={onClear}>
          不设结束时间
        </button>
        <span className="spacer" />
        <button className="secondary" onClick={onClose}>
          取消
        </button>
      </div>
    </Dialog>
  )
}
