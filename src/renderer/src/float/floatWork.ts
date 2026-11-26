import type { PlanBlock, StartTimerInput, Task } from '@shared/types'
import { isPlayableBlock } from '@shared/plan'
import { MIN_MS } from '@shared/time'

export function selectFloatWork(tasks: Task[], blocks: PlanBlock[], startedPlanIds: ReadonlySet<string>, now: Date) {
  const scheduledIds = new Set(blocks.map((b) => b.taskId))
  const playable = blocks.filter(isPlayableBlock)
  const at = now.getTime()
  return {
    unscheduled: tasks.filter((t) => t.status === 'active' && !scheduledIds.has(t.id)),
    current: playable.find((b) => Date.parse(b.startAt) <= at && at < Date.parse(b.endAt)) ?? null,
    upcoming: playable.filter((b) => Date.parse(b.startAt) > at && !startedPlanIds.has(b.id))
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
  }
}

export function matchesPickerQuery(fields: (string | undefined)[], query: string): boolean {
  const text = fields.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase()
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).every((term) => text.includes(term))
}

export function planTimerInput(block: PlanBlock, now: Date): StartTimerInput {
  return {
    taskId: block.taskId,
    title: block.taskId ? undefined : block.title,
    categoryId: block.categoryId,
    planBlockId: block.id,
    // 提前做也只做原定时长，不把等待到原计划开始的时间算进去。
    ...(Date.parse(block.startAt) > now.getTime() ? {
      durationMin: Math.max(1, Math.round((Date.parse(block.endAt) - Date.parse(block.startAt)) / MIN_MS))
    } : {})
  }
}
