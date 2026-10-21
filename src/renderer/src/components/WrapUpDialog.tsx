import { useEffect, useState } from 'react'
import type { OverrunReason, Settings, Task, TimeEntry } from '@shared/types'
import { OVERRUN_REASONS } from '@shared/types'
import { dayOf, dayRange, formatElapsed } from '@shared/time'
import { isOverrun } from '@shared/session'
import { Dialog, type Mutate } from '../ui'

interface Props {
  settings: Settings
  mutate: Mutate
  onClose: () => void
  /** 收尾完接着做今日复盘 */
  onReview: () => void
}

/**
 * 收尾流程：离开自习室或准备睡觉时用。
 * 1. 停下正在进行的计时  2. 给今天碰过、还没完成的任务写下一步，或改到改天再看
 */
export function WrapUpDialog({ settings, mutate, onClose, onReview }: Props) {
  const [running, setRunning] = useState<TimeEntry | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [nextSteps, setNextSteps] = useState<Record<string, string>>({})
  const [completed, setCompleted] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState<OverrunReason | null>(null)
  const [step, setStep] = useState<'stop' | 'tasks' | 'done'>('stop')

  useEffect(() => {
    ;(async () => {
      const r = await window.api.entries.running()
      const { start, end } = dayRange(dayOf(new Date(), settings.dayStartHour), settings.dayStartHour)
      const [entries, blocks, open] = await Promise.all([
        window.api.entries.list(start.toISOString(), end.toISOString()),
        window.api.plan.list(start.toISOString(), end.toISOString()),
        window.api.tasks.list({ status: 'active' })
      ])
      // 今天做过或排过的未完成任务
      const touched = new Set([...entries, ...blocks].map((x) => x.taskId).filter(Boolean))
      const list = open.filter((t) => touched.has(t.id))
      setRunning(r)
      setTasks(list)
      setNextSteps(Object.fromEntries(list.map((t) => [t.id, t.nextStep])))
      setStep(r ? 'stop' : 'tasks')
    })()
  }, [settings.dayStartHour])

  const stop = async () => {
    const ok = await mutate(() =>
      window.api.entries.stop({ overrunReason: running && isOverrun(running, settings.overrunAskRatio) ? reason : null })
    )
    if (ok) setStep('tasks')
  }

  const save = async () => {
    await mutate(async () => {
      for (const t of tasks) {
        if (completed[t.id]) await window.api.tasks.update(t.id, { status: 'done', nextStep: nextSteps[t.id] ?? '' })
        else if ((nextSteps[t.id] ?? '') !== t.nextStep) await window.api.tasks.update(t.id, { nextStep: nextSteps[t.id] ?? '' })
      }
    })
    setStep('done')
  }

  return (
    <Dialog title="收尾" onClose={onClose}>
      <ol className="wrap-steps" aria-label="步骤">
        <li className={step === 'stop' ? 'on' : ''}>停下计时</li>
        <li className={step === 'tasks' ? 'on' : ''}>写好下一步</li>
        <li className={step === 'done' ? 'on' : ''}>完成</li>
      </ol>

      {step === 'stop' && running && (
        <>
          <p className="dialog-lead">
            「{running.title}」已经进行了 {formatElapsed(Date.now() - new Date(running.startAt).getTime())}。先把它停下来。
          </p>
          {isOverrun(running, settings.overrunAskRatio) && (
            <fieldset className="reasons">
              <legend>比原定久了不少，主要是因为？（可以跳过）</legend>
              {OVERRUN_REASONS.map((r) => (
                <label key={r.value} className={`reason ${reason === r.value ? 'on' : ''}`}>
                  <input type="radio" name="wrap-reason" checked={reason === r.value} onChange={() => setReason(r.value)} />
                  <span>{r.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>
              还不收尾
            </button>
            <button autoFocus onClick={stop}>
              停下计时
            </button>
          </div>
        </>
      )}

      {step === 'tasks' && (
        <>
          {tasks.length === 0 ? (
            <p className="dialog-lead">今天没有留下没做完的任务。</p>
          ) : (
            <>
              <p className="dialog-lead">今天碰过、还没完成的任务。写一句下一步，下次打开就知道从哪里接着做。</p>
              <ul className="wrap-tasks">
                {tasks.map((t, i) => (
                  <li key={t.id}>
                    <div className="wrap-task-head">
                      <span className={completed[t.id] ? 'is-done' : ''}>{t.title}</span>
                      <label className="check small">
                        <input type="checkbox" checked={!!completed[t.id]} onChange={(e) => setCompleted({ ...completed, [t.id]: e.target.checked })} />
                        已完成
                      </label>
                    </div>
                    {!completed[t.id] && (
                      <input
                        autoFocus={i === 0}
                        aria-label={`「${t.title}」的下一步`}
                        placeholder="下一步"
                        value={nextSteps[t.id] ?? ''}
                        onChange={(e) => setNextSteps({ ...nextSteps, [t.id]: e.target.value })}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-actions">
            <button onClick={tasks.length ? save : () => setStep('done')}>{tasks.length ? '保存' : '好'}</button>
          </div>
        </>
      )}

      {step === 'done' && (
        <>
          <p className="dialog-lead">收好了。剩下的事都在待办里，不会丢。</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>
              关闭
            </button>
            <button autoFocus onClick={onReview}>
              顺手复盘今天
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
