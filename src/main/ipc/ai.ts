import type { AiConfigPatch, CaptureDraft, ImportFile, SuggestedBlock } from '@shared/types'
import type { AiConfigStore } from '../ai/config'
import type { HabitRepo } from '../db/habitRepo'
import type { AiService } from '../ai/service'
import type { IpcRegistry } from './registry'

export function registerAiIpc(reg: IpcRegistry, deps: { aiConfig: AiConfigStore; habits: HabitRepo; ai: AiService }): void {
  const { aiConfig, habits, ai } = deps
  reg.handle('ai:getConfig', () => aiConfig.view())
  reg.handle('ai:setConfig', (patch: AiConfigPatch) => aiConfig.update(patch))
  reg.handle('ai:test', () => ai.test())
  reg.handle('ai:parseCapture', (text: string) => ai.parseCapture(text))
  reg.handle('ai:reparseCapture', (text: string, previous: CaptureDraft, feedback: string[]) => ai.reparseCapture(text, previous, feedback))
  reg.handle('ai:parseSchedule', (files: ImportFile[], hint: string) => ai.parseSchedule(files, hint))

  reg.handle('habits:list', () => habits.list())
  reg.handle('habits:add', (text: string, example?: string, replacesId?: string | null) => habits.add(text, example, replacesId ?? null))
  reg.handle('habits:update', (id: string, patch: { text?: string; enabled?: boolean }) => habits.update(id, patch))
  reg.handle('habits:remove', (id: string) => habits.remove(id))
  reg.handle('habits:markUsed', (ids: string[]) => habits.markUsed(Array.isArray(ids) ? ids : []))

  reg.handle('planner:suggest', (day: string, hint: string) => ai.suggestDayPlan(day, hint))
  reg.handle('planner:accept', (_day: string, blocks: SuggestedBlock[]) => ai.acceptDayPlan(blocks))
}
