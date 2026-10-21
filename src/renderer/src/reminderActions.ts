import { useEffect, useState } from 'react'
import type { Reminder } from '@shared/types'
import type { ReminderActions } from './components/ReminderCard'

/** 订阅当前提醒 */
export function useReminder(): Reminder | null {
  const [r, setR] = useState<Reminder | null>(null)
  useEffect(() => {
    window.api.reminders.current().then(setR)
    return window.api.reminders.onChange(setR)
  }, [])
  return r
}

/**
 * 提醒按钮的通用行为。结束和收尾因为要弹对话框，由调用方决定怎么做。
 * run 负责错误提示。
 */
export function reminderActions(
  r: Reminder,
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>,
  handlers: { onStop: () => void; onWrapUp: () => void }
): ReminderActions {
  return {
    ...handlers,
    onExtend: (min) =>
      run(async () => {
        await window.api.entries.extend(min)
        // 睡前「再做 N 分钟」：这段时间内睡眠提醒先不出现，到点再提醒
        if (r.kind === 'sleep' || r.kind === 'sleep-lead') await window.api.reminders.snooze(r.id, min)
      }),
    onSpinOff: (title) =>
      run(async () => {
        await window.api.entries.stop({ overrunReason: 'scope' })
        if (r.taskId) await window.api.tasks.spinOff(r.taskId, { title })
      }),
    onStartBlock: (blockId) =>
      run(async () => {
        const blocks = await window.api.plan.list(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString())
        const b = blocks.find((x) => x.id === blockId)
        if (!b) throw new Error('计划已经不存在了')
        await window.api.entries.start({ taskId: b.taskId, title: b.taskId ? undefined : b.title, categoryId: b.categoryId, planBlockId: b.id })
      }),
    onDismiss: (scope) => run(() => window.api.reminders.dismiss(r.id, scope)),
    onSnooze: (min) => run(() => window.api.reminders.snooze(r.id, min))
  }
}
