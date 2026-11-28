import type { IpcMain } from 'electron'
import type { Repo } from '../db/repo'
import type { TimeRepo } from '../db/timeRepo'
import type { CourseRepo } from '../db/courseRepo'
import type { ReviewRepo } from '../db/reviewRepo'
import type { WeeklyRepo } from '../db/weeklyRepo'
import type { HabitRepo } from '../db/habitRepo'
import type { AiConfigStore } from '../ai/config'
import type { AiService } from '../ai/service'
import { createIpcRegistry, type IpcRegistryGuards } from './registry'
import { registerTasksIpc } from './tasks'
import { registerTimeIpc } from './time'
import { registerReviewIpc } from './review'
import { registerAiIpc } from './ai'
import { registerSystemIpc, type SystemIpcDeps } from './system'

export interface AppIpcDeps extends SystemIpcDeps {
  repo: Repo
  time: TimeRepo
  courses: CourseRepo
  review: ReviewRepo
  weekly: WeeklyRepo
  habits: HabitRepo
  plannerHabits: HabitRepo
  aiConfig: AiConfigStore
  ai: AiService
  guards: IpcRegistryGuards
}

/** 统一装配全应用业务 IPC，并在启动时校验所有清单通道均已注册 */
export function registerAppIpc(ipc: Pick<IpcMain, 'handle'>, deps: AppIpcDeps): void {
  const reg = createIpcRegistry(ipc, deps.guards)
  registerTasksIpc(reg, deps.repo)
  registerTimeIpc(reg, deps)
  registerReviewIpc(reg, deps)
  registerAiIpc(reg, deps)
  registerSystemIpc(reg, ipc, deps)
  reg.assertComplete()
}
