import type { BlockInput, EntryInput, OverrunReason, ScheduleDraft, StartTimerInput, StopTimerInput } from '@shared/types'
import type { TimeRepo } from '../db/timeRepo'
import type { CourseRepo } from '../db/courseRepo'
import type { IpcRegistry } from './registry'

export function registerTimeIpc(reg: IpcRegistry, deps: { time: TimeRepo; courses: CourseRepo }): void {
  const { time, courses } = deps
  reg.handle('plan:list', (from: string, to: string) => time.listBlocks(from, to))
  reg.handle('plan:startedIds', (from: string, to: string) => time.startedBlockIds(from, to))
  reg.handle('plan:create', (input: BlockInput) => time.createBlock(input))
  reg.handle('plan:copy', (id: string, startAt: string) => time.copyBlock(id, startAt))
  reg.handle('plan:update', (id: string, patch: Partial<BlockInput>) => time.updateBlock(id, patch))
  reg.handle('plan:remove', (id: string) => time.deleteBlock(id))

  reg.handle('entries:list', (from: string, to: string) => time.listEntries(from, to))
  reg.handle('entries:create', (input: EntryInput) => time.createEntry(input))
  reg.handle('entries:update', (id: string, patch: Partial<EntryInput>) => time.updateEntry(id, patch))
  reg.handle('entries:remove', (id: string) => time.deleteEntry(id))
  reg.handle('entries:running', () => time.running())
  reg.handle('entries:start', (input: StartTimerInput) => time.start(input))
  reg.handle('entries:stop', (input: StopTimerInput) => time.stop(input))
  reg.handle('entries:extend', (min: number) => time.extend(min))
  reg.handle('entries:setTarget', (endAt: string | null) => time.setTarget(endAt))
  reg.handle('entries:setReason', (id: string, reason: OverrunReason | null) => time.setReason(id, reason))

  reg.handle('courses:list', () => courses.list())
  reg.handle('courses:commit', (draft: ScheduleDraft, replace: boolean) => courses.commit(draft, replace))
  reg.handle('courses:removeAll', () => courses.removeAll())
}
