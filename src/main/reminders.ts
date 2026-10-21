import type { PlanBlock, Reminder, ReminderKind, Settings, TimeEntry } from '@shared/types'
import type { TimeRepo } from './db/timeRepo'
import { nextClock, sleepWindow } from './db/timeRepo'

/**
 * 提醒规则（纯逻辑，不碰窗口）。
 * 每次 tick 根据当前状态算出「此刻应该提醒什么」，状态里记住已关闭 / 稍后的提醒，避免反复弹出。
 */

const MIN = 60_000
/** 计划块开始提醒的有效期：错过太久就不再提醒 */
const BLOCK_START_GRACE = 10 * MIN

// 优先级：越靠前越重要，同一时刻只显示一个
const PRIORITY: ReminderKind[] = ['sleep', 'sleep-lead', 'leave', 'session-end', 'block-end', 'block-start']

export interface Snapshot {
  now: Date
  settings: Settings
  running: TimeEntry | null
  /** 今天剩下的计划（含正在进行的） */
  blocks: PlanBlock[]
}

interface Candidate {
  /** 稳定的标识：同一件事反复计算得到同一个 key */
  key: string
  /** 同类提醒的分组，「今晚不再提醒」按组生效 */
  group: string
  kind: ReminderKind
  strong: boolean
  title: string
  body: string
  entryId?: string
  blockId?: string
  taskId?: string | null
  /** 计算影响时假定继续到这个时刻 */
  continueUntil?: Date
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

export function candidates(s: Snapshot): Candidate[] {
  const { now, settings: cfg, running } = s
  const out: Candidate[] = []
  const sleep = sleepWindow(now, cfg)
  const night = dayKey(sleep.start)

  // 睡眠窗口：进入后强提醒；在那之前 sleepLeadMin 分钟轻量预告
  if (sleep.inside) {
    out.push({
      key: `sleep:${night}`,
      group: `sleep:${night}`,
      kind: 'sleep',
      strong: true,
      title: '到睡眠时间了',
      body: running
        ? `「${running.title}」还在计时。先停下来，把下一步记下，明天接着做。`
        : `睡眠窗口 ${cfg.sleepStart}–${cfg.sleepEnd}。剩下的事明天再安排。`,
      entryId: running?.id,
      taskId: running?.taskId
    })
  } else if (cfg.sleepLeadMin > 0 && sleep.start.getTime() - now.getTime() <= cfg.sleepLeadMin * MIN) {
    const left = Math.round((sleep.start.getTime() - now.getTime()) / MIN)
    out.push({
      key: `sleep-lead:${night}`,
      group: `sleep:${night}`,
      kind: 'sleep-lead',
      strong: true,
      title: `${left} 分钟后进入睡眠窗口`,
      body: running ? `「${running.title}」可以开始收尾了。` : '可以开始收尾，准备休息。',
      entryId: running?.id,
      taskId: running?.taskId,
      continueUntil: sleep.start
    })
  }

  // 自习室离开时间：提前 leaveLeadMin 分钟提醒收尾
  if (cfg.leaveEnabled) {
    const leave = nextClock(new Date(now.getTime() - 60 * MIN), cfg.leaveTime)
    const since = now.getTime() - leave.getTime()
    if (since >= -cfg.leaveLeadMin * MIN && since < 60 * MIN) {
      const left = Math.round(-since / MIN)
      out.push({
        key: `leave:${dayKey(leave)}`,
        group: `leave:${dayKey(leave)}`,
        kind: 'leave',
        strong: false,
        title: left > 0 ? `${left} 分钟后该离开自习室了` : '该离开自习室了',
        body: '停下计时，给没做完的任务写好下一步，再收拾东西。',
        entryId: running?.id,
        taskId: running?.taskId
      })
    }
  }

  // 本次投入到点
  if (running?.targetEndAt && now >= new Date(running.targetEndAt)) {
    const over = Math.round((now.getTime() - new Date(running.targetEndAt).getTime()) / MIN)
    out.push({
      key: `session-end:${running.id}:${running.targetEndAt}`,
      group: `session-end:${running.id}`,
      kind: 'session-end',
      strong: false,
      title: over > 0 ? `本次时间已过 ${over} 分钟` : '本次时间到了',
      body: `「${running.title}」：结束、延长，还是把多出来的部分拆成新任务？`,
      entryId: running.id,
      taskId: running.taskId,
      continueUntil: new Date(now.getTime() + cfg.extendStepMin * MIN)
    })
  }

  if (cfg.blockReminders) {
    for (const b of s.blocks) {
      // 上课时段由课表生成，上课时不需要软件来催
      if (b.courseId) continue
      const start = new Date(b.startAt)
      const end = new Date(b.endAt)
      const isCurrentWork = running && (running.planBlockId === b.id || (b.taskId && running.taskId === b.taskId))

      // 计划块开始：没在做这件事时提醒一次
      if (!isCurrentWork && b.taskStatus !== 'done' && now >= start && now.getTime() - start.getTime() < BLOCK_START_GRACE && now < end) {
        out.push({
          key: `block-start:${b.id}:${b.startAt}`,
          group: `block-start:${b.id}`,
          kind: 'block-start',
          strong: false,
          title: `计划开始：${b.title}`,
          body: running ? `现在在做「${running.title}」。要切换过去吗？` : `${hm(start)}–${hm(end)}，现在开始？`,
          blockId: b.id,
          taskId: b.taskId
        })
      }

      // 保留时段（娱乐等）结束：没有任务的计划块到点提醒
      if (!b.taskId && now >= end && now.getTime() - end.getTime() < 30 * MIN) {
        out.push({
          key: `block-end:${b.id}:${b.endAt}`,
          group: `block-end:${b.id}`,
          kind: 'block-end',
          strong: false,
          title: `「${b.title}」的时间到了`,
          body: '保留的时段结束了。想继续也可以，只是提醒你一下。',
          blockId: b.id
        })
      }
    }
  }

  return out.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
}

/** 有状态的提醒中心：记住关闭和稍后，向外给出当前要显示的提醒 */
export class ReminderCenter {
  private dismissedKeys = new Set<string>()
  private dismissedGroups = new Set<string>()
  private snoozed = new Map<string, number>()
  private seen = new Set<string>()
  private current: (Reminder & { key: string; group: string }) | null = null

  constructor(private time: TimeRepo) {}

  /** 计算当前提醒；返回值变化时需要通知界面 */
  evaluate(s: Snapshot): Reminder | null {
    const t = s.now.getTime()
    for (const [k, until] of this.snoozed) if (until <= t) this.snoozed.delete(k)

    const pick = candidates(s).find(
      (c) => !this.dismissedKeys.has(c.key) && !this.dismissedGroups.has(c.group) && !this.snoozed.has(c.group)
    )
    if (!pick) {
      this.current = null
      return null
    }

    const fresh = !this.seen.has(pick.key)
    this.seen.add(pick.key)
    const withImpact = pick.kind === 'session-end' || pick.kind === 'sleep-lead' || pick.kind === 'leave'
    this.current = {
      id: pick.key,
      key: pick.key,
      group: pick.group,
      kind: pick.kind,
      strong: pick.strong,
      title: pick.title,
      body: pick.body,
      entryId: pick.entryId,
      blockId: pick.blockId,
      taskId: pick.taskId,
      extendMin: s.settings.extendStepMin,
      impact: withImpact ? this.time.impact(pick.continueUntil ?? s.now, s.running?.planBlockId ?? null) : undefined,
      fresh
    }
    return this.publicView()
  }

  get(): Reminder | null {
    return this.publicView()
  }

  private publicView(): Reminder | null {
    if (!this.current) return null
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { key, group, ...r } = this.current
    return r
  }

  dismiss(id: string, scope: 'once' | 'group' = 'once'): void {
    this.dismissedKeys.add(id)
    if (scope === 'group' && this.current?.key === id) this.dismissedGroups.add(this.current.group)
    if (this.current?.key === id) this.current = null
  }

  snooze(id: string, min: number, now: Date): void {
    if (this.current?.key !== id) return
    this.snoozed.set(this.current.group, now.getTime() + min * MIN)
    this.current = null
  }
}
