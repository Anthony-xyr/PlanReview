import type { CaptureDraft, ImportFile, SuggestedBlock } from '@shared/types'
import { dayRange } from '@shared/time'
import type { Repo } from '../db/repo'
import { sleepWindow, type TimeRepo } from '../db/timeRepo'
import type { ReviewRepo } from '../db/reviewRepo'
import type { WeeklyRepo } from '../db/weeklyRepo'
import type { HabitRepo } from '../db/habitRepo'
import type { AiConfigStore } from './config'
import { chat } from './client'
import { parseCapture, reparseCapture } from './capture'
import { parseSchedule } from './schedule'
import { askWeekly, generateWeekly, weekContextText, type WeekContext } from './weekly'
import { freeGaps, suggestPlan } from './planner'

export interface AiServiceDeps {
  repo: Repo
  time: TimeRepo
  review: ReviewRepo
  weekly: WeeklyRepo
  habits: HabitRepo
  aiConfig: AiConfigStore
}

/** 聚合 AI 相关的用例编排，让 IPC 层与主进程入口保持精简 */
export class AiService {
  constructor(private deps: AiServiceDeps) {}

  async test(): Promise<{ ok: true; model: string; ms: number }> {
    const ep = this.deps.aiConfig.endpoint()
    const t = Date.now()
    await chat(ep, [{ role: 'user', content: '只回复两个字：好的' }], { timeoutMs: 20_000 })
    return { ok: true, model: ep.model, ms: Date.now() - t }
  }

  parseCapture(text: string) {
    const { aiConfig, repo, habits } = this.deps
    return parseCapture(aiConfig.endpoint(), text, repo.listCategories(), repo.listTags(), new Date(), aiConfig.effort('capture'), habits.enabled())
  }

  reparseCapture(text: string, previous: CaptureDraft, feedback: string[]) {
    const notes = (Array.isArray(feedback) ? feedback : []).map((f) => String(f).trim().slice(0, 300)).filter(Boolean).slice(-5)
    if (!notes.length) throw new Error('写一句哪里不对')
    const { aiConfig, repo, habits } = this.deps
    return reparseCapture(aiConfig.endpoint(), text, previous, notes, repo.listCategories(), repo.listTags(), new Date(), aiConfig.effort('capture'), habits.enabled())
  }

  parseSchedule(files: ImportFile[], hint: string) {
    const { aiConfig } = this.deps
    return parseSchedule(aiConfig.endpoint(files.some((f) => f.kind === 'image')), files, hint, aiConfig.effort('schedule'))
  }

  /** 周复盘要给 AI 的全部材料：统计、每日复盘原话、待办估时、已确认的画像 */
  weekContext(weekStart: string): WeekContext {
    const { repo, time, review, weekly } = this.deps
    const notes = Array.from({ length: 7 }, (_, i) => {
      const [y, m, d] = weekStart.split('-').map(Number)
      const dt = new Date(y, m - 1, d + i)
      const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      const r = review.getReview(day)
      return { day, mood: r?.mood ?? null, note: r?.note ?? '' }
    })
    return {
      stats: weekly.stats(weekStart),
      notes,
      categories: repo.listCategories(),
      settings: time.getSettings(),
      openTasks: repo.listTasks({ status: ['inbox', 'active'] }),
      insights: weekly.acceptedInsights()
    }
  }

  async generateWeeklyReview(weekStart: string) {
    const { aiConfig, weekly } = this.deps
    const ep = aiConfig.endpoint()
    const { report, insights } = await generateWeekly(ep, this.weekContext(weekStart), aiConfig.effort('weeklyReview'))
    return weekly.saveReport(weekStart, report, ep.model, insights)
  }

  async askWeeklyReview(weekStart: string, question: string) {
    const { aiConfig, weekly } = this.deps
    const q = question.trim()
    if (!q) throw new Error('问题不能为空')
    if (q.length > 1000) throw new Error('问题太长了')
    const r = weekly.get(weekStart)
    if (!r?.report) throw new Error('先生成这一周的复盘')
    const answer = await askWeekly(aiConfig.endpoint(), weekContextText(this.weekContext(weekStart)), r.report, r.messages, q, aiConfig.effort('weeklyQA'))
    // 先拿到回答再写入，失败时不留半截对话
    weekly.addMessage(weekStart, 'user', q)
    return weekly.addMessage(weekStart, 'assistant', answer)
  }

  async suggestDayPlan(day: string, hint: string) {
    const { aiConfig, repo, time, weekly } = this.deps
    const cfg = time.getSettings()
    const { start, end } = dayRange(day, cfg.dayStartHour)
    const now = new Date()
    const from = new Date(Math.max(now.getTime(), start.getTime()))
    if (from >= end) throw new Error('这一天已经过去了')
    // 排到睡眠窗口开始为止
    const sleep = sleepWindow(from, cfg)
    const until = new Date(Math.min(end.getTime(), sleep.inside ? from.getTime() : sleep.start.getTime()))
    const blocks = time.listBlocks(start.toISOString(), end.toISOString())
    const scheduled = new Set(blocks.filter((b) => new Date(b.endAt) > now).map((b) => b.taskId))
    return suggestPlan(
      aiConfig.endpoint(),
      {
        day,
        now: from,
        gaps: freeGaps(from, until, blocks),
        blocks,
        tasks: repo.listTasks({ status: ['inbox', 'active'] }).filter((t) => !scheduled.has(t.id)),
        categories: repo.listCategories(),
        insights: weekly.acceptedInsights(),
        hint
      },
      cfg.dayStartHour,
      aiConfig.effort('planner')
    )
  }

  /** 写入用户勾选的建议；逐条走正常的建块校验，有一条失败就整体回滚 */
  acceptDayPlan(blocks: SuggestedBlock[]): { created: number } {
    if (!Array.isArray(blocks) || blocks.length > 30) throw new Error('建议格式不对')
    const created: string[] = []
    try {
      for (const b of blocks) created.push(this.deps.time.createBlock({ taskId: b.taskId, title: b.title, startAt: b.startAt, endAt: b.endAt }).id)
    } catch (e) {
      for (const id of created) this.deps.time.deleteBlock(id)
      throw e
    }
    return { created: created.length }
  }
}
