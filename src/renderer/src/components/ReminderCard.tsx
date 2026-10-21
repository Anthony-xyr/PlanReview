import { useState } from 'react'
import type { Reminder } from '@shared/types'
import { describeImpact } from '@shared/session'

export interface ReminderActions {
  /** 结束本次（打开结束对话框或交给主窗口） */
  onStop: () => void
  onExtend: (min: number) => void
  /** 拆出新任务：结束本次，并把多出来的部分记成延伸任务 */
  onSpinOff: (title: string) => void
  onWrapUp: () => void
  onStartBlock: (blockId: string) => void
  onDismiss: (scope?: 'once' | 'group') => void
  onSnooze: (min: number) => void
}

/** 提醒卡片：主窗口和悬浮窗共用 */
export function ReminderCard({ reminder: r, compact, ...a }: { reminder: Reminder; compact?: boolean } & ReminderActions) {
  const [spinning, setSpinning] = useState(false)
  const [spinTitle, setSpinTitle] = useState('')
  const step = r.extendMin ?? 15
  const hasTimer = !!r.entryId
  const impact = r.impact ? describeImpact(r.impact, r.kind === 'session-end' ? step : undefined) : []

  return (
    <div className={`reminder ${r.strong ? 'is-strong' : ''} ${compact ? 'is-compact' : ''}`} role="alertdialog" aria-label={r.title}>
      <div className="reminder-title">{r.title}</div>
      <div className="reminder-body">{r.body}</div>
      {impact.length > 0 && (
        <ul className="reminder-impact">
          {impact.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}

      {spinning ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (spinTitle.trim()) a.onSpinOff(spinTitle.trim())
          }}
        >
          <input autoFocus aria-label="新任务名称" placeholder="多出来的部分，比如：补充第 4 节推导" value={spinTitle} onChange={(e) => setSpinTitle(e.target.value)} />
          <button type="submit" disabled={!spinTitle.trim()}>
            拆出并结束
          </button>
          <button type="button" className="secondary" onClick={() => setSpinning(false)}>
            返回
          </button>
        </form>
      ) : (
        <div className="reminder-actions">
          {r.kind === 'session-end' && (
            <>
              <button onClick={a.onStop}>结束本次</button>
              <button className="secondary" onClick={() => a.onExtend(step)}>
                延长 {step} 分钟
              </button>
              {r.taskId && (
                <button className="secondary" onClick={() => setSpinning(true)}>
                  拆出新任务
                </button>
              )}
            </>
          )}
          {(r.kind === 'sleep' || r.kind === 'sleep-lead' || r.kind === 'leave') && (
            <>
              <button onClick={a.onWrapUp}>开始收尾</button>
              {hasTimer && r.kind !== 'leave' && (
                <button className="secondary" onClick={() => a.onExtend(step)}>
                  再做 {step} 分钟
                </button>
              )}
              <button className="secondary" onClick={() => a.onSnooze(10)}>
                10 分钟后再说
              </button>
              {r.kind !== 'leave' && (
                <button className="link" onClick={() => a.onDismiss('group')}>
                  今晚不再提醒
                </button>
              )}
            </>
          )}
          {r.kind === 'block-start' && (
            <>
              <button onClick={() => a.onStartBlock(r.blockId!)}>{hasTimer ? '切换过去' : '开始'}</button>
              <button className="secondary" onClick={() => a.onDismiss()}>
                先不了
              </button>
            </>
          )}
          {r.kind === 'block-end' && (
            <>
              <button onClick={() => a.onDismiss()}>知道了</button>
              <button className="secondary" onClick={() => a.onSnooze(15)}>
                15 分钟后再提醒
              </button>
            </>
          )}
          {r.kind === 'session-end' && (
            <button className="link" onClick={() => a.onSnooze(5)}>
              5 分钟后再问
            </button>
          )}
        </div>
      )}
    </div>
  )
}
