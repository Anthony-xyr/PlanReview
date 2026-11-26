import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { MainCommand, Settings, SystemStatus, TimerOverlayState } from '@shared/types'
import { TIMER_IPC } from '@shared/ipc'
import type { TimeRepo } from '../db/timeRepo'
import type { ReminderCenter } from '../reminders'
import type { IpcRegistry } from './registry'

export interface SystemIpcDeps {
  time: TimeRepo
  center: ReminderCenter
  updateSettings(patch: Partial<Settings>): Settings
  openMain(cmd?: MainCommand): void
  showFloat(): void
  hideFloat(): void
  floatReady(): void
  resizeFloat(height: number): void
  status(): SystemStatus
  timer: {
    accepts(event: IpcMainInvokeEvent): boolean
    snapshot(): TimerOverlayState
    resize(width: number): void
  }
}

export function registerSystemIpc(reg: IpcRegistry, ipc: Pick<IpcMain, 'handle'>, deps: SystemIpcDeps): void {
  reg.handle('settings:get', () => deps.time.getSettings())
  reg.handle('settings:update', (patch: Partial<Settings>) => deps.updateSettings(patch))

  reg.handle('reminders:current', () => deps.center.get())
  reg.handle('reminders:dismiss', (id: string, scope?: 'once' | 'group') => deps.center.dismiss(id, scope))
  reg.handle('reminders:snooze', (id: string, min: number) => deps.center.snooze(id, min, new Date()))

  reg.handle('win:openMain', (cmd?: MainCommand) => deps.openMain(cmd))
  reg.handle('win:showFloat', () => deps.showFloat())
  reg.handle('win:hideFloat', () => deps.hideFloat())
  reg.handle('win:floatReady', () => deps.floatReady())
  reg.handle('win:resizeFloat', (height: number) => deps.resizeFloat(height))
  reg.handle('win:status', () => deps.status())

  ipc.handle(TIMER_IPC.state, (e) => {
    if (!deps.timer.accepts(e)) throw new Error('仅顶部计时器可使用此通道')
    return deps.timer.snapshot()
  })
  ipc.handle(TIMER_IPC.resize, (e, width: number) => {
    if (!deps.timer.accepts(e)) throw new Error('仅顶部计时器可使用此通道')
    deps.timer.resize(width)
  })
}
