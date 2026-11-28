import type { DailyReviewInput, InsightStatus, ResurfaceAction } from '@shared/types'
import type { ReviewRepo } from '../db/reviewRepo'
import type { WeeklyRepo } from '../db/weeklyRepo'
import type { AiService } from '../ai/service'
import type { IpcRegistry } from './registry'

export function registerReviewIpc(reg: IpcRegistry, deps: { review: ReviewRepo; weekly: WeeklyRepo; ai: AiService }): void {
  const { review, weekly, ai } = deps
  reg.handle('resurface:get', (day: string) => review.get(day))
  reg.handle('resurface:act', (taskId: string, action: ResurfaceAction) => review.act(taskId, action))
  reg.handle('resurface:reroll', (day: string) => review.reroll(day))
  reg.handle('resurface:dismissTidy', (day: string) => review.dismissTidy(day))

  reg.handle('review:summary', (day: string) => review.summary(day))
  reg.handle('review:save', (day: string, input: DailyReviewInput) => review.save(day, input))

  reg.handle('weekly:stats', (weekStart: string) => weekly.stats(weekStart))
  reg.handle('weekly:activeWeeks', () => weekly.activeWeeks())
  reg.handle('weekly:get', (weekStart: string) => weekly.get(weekStart))
  reg.handle('weekly:generate', (weekStart: string) => ai.generateWeeklyReview(weekStart))
  reg.handle('weekly:ask', (weekStart: string, question: string) => ai.askWeeklyReview(weekStart, question))
  reg.handle('weekly:apply', (weekStart: string, id: string) => weekly.apply(weekStart, id))
  reg.handle('weekly:dismiss', (weekStart: string, id: string) => weekly.dismiss(weekStart, id))

  reg.handle('insights:list', () => weekly.listInsights())
  reg.handle('insights:update', (id: string, patch: { status?: InsightStatus; text?: string }) => weekly.updateInsight(id, patch))
  reg.handle('insights:remove', (id: string) => weekly.removeInsight(id))
}
