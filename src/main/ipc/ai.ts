import type { AiConfigPatch, CaptureDraft, HabitKind, ImportFile, PlanAcceptance, SuggestedBlock } from '@shared/types'
import type { AiConfigStore } from '../ai/config'
import type { HabitRepo } from '../db/habitRepo'
import type { AiService } from '../ai/service'
import type { IpcRegistry } from './registry'

export function registerAiIpc(reg: IpcRegistry, deps: { aiConfig: AiConfigStore; habits: HabitRepo; plannerHabits: HabitRepo; ai: AiService }): void {
  const { aiConfig, habits, plannerHabits, ai } = deps
  reg.handle('ai:getConfig', () => aiConfig.view())
  reg.handle('ai:setConfig', (patch: AiConfigPatch) => aiConfig.update(patch))
  reg.handle('ai:test', () => ai.test())
  reg.handle('ai:parseCapture', (text: string) => ai.parseCapture(text))
  reg.handle('ai:reparseCapture', (text: string, previous: CaptureDraft, feedback: string[]) => ai.reparseCapture(text, previous, feedback))
  reg.handle('ai:parseSchedule', (files: ImportFile[], hint: string) => ai.parseSchedule(files, hint))

  // 外部 kind 仅按两个字面量选择，缺省/null/未知值和原型链键一律走速记。
  const forKind = (kind: unknown) => kind === 'planner' ? plannerHabits : habits
  reg.handle('habits:list', (kind?: HabitKind) => forKind(kind).list())
  reg.handle('habits:add', (text: string, example?: string, replacesId?: string | null, kind?: HabitKind) => forKind(kind).add(text, example, replacesId ?? null))
  reg.handle('habits:update', (id: string, patch: { text?: string; enabled?: boolean }, kind?: HabitKind) => forKind(kind).update(id, patch))
  reg.handle('habits:remove', (id: string, kind?: HabitKind) => forKind(kind).remove(id))
  reg.handle('habits:markUsed', (ids: string[], kind?: HabitKind) => forKind(kind).markUsed(Array.isArray(ids) ? ids : []))

  reg.handle('planner:suggest', (day: string, hint: string) => ai.suggestDayPlan(day, hint))
  reg.handle('planner:replan', (day: string, hint: string, previous: SuggestedBlock[], feedback: string[]) => ai.replanDay(day, hint, previous, feedback))
  reg.handle('planner:accept', (_day: string, blocks: SuggestedBlock[], confirmation?: PlanAcceptance) => ai.acceptDayPlan(blocks, confirmation))
}
