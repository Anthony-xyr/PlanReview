import { contextBridge, ipcRenderer } from 'electron'
import type { Api, MainCommand, Reminder, TimerOverlayState } from '@shared/types'
import { createInvokeBridge, IPC_EVENTS, TIMER_IPC } from '@shared/ipc'
import { UPDATE_IPC, type UpdateSnapshot } from '@shared/update'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

/** 订阅主进程消息，返回取消订阅函数 */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge = createInvokeBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args))

const api = {
  ...bridge,
  update: {
    state: call(UPDATE_IPC.state),
    check: call(UPDATE_IPC.check),
    setAutoCheck: call(UPDATE_IPC.setAutoCheck),
    restart: call(UPDATE_IPC.restart),
    respondToRestart: call(UPDATE_IPC.respondToRestart),
    openReleases: call(UPDATE_IPC.openReleases),
    onChanged: (cb: (state: UpdateSnapshot) => void) => on(UPDATE_IPC.changed, cb)
  },
  reminders: {
    ...bridge.reminders,
    onChange: (cb: (r: Reminder | null) => void) => on(IPC_EVENTS.reminder, cb)
  },
  events: {
    onDataChanged: (cb: () => void) => on(IPC_EVENTS.dataChanged, cb),
    onCommand: (cb: (cmd: MainCommand) => void) => on(IPC_EVENTS.command, cb),
    onResume: (cb: () => void) => on(IPC_EVENTS.resume, cb)
  },
  win: {
    ...bridge.win,
    platform: process.platform
  },
  timer: {
    state: call(TIMER_IPC.state),
    resize: call(TIMER_IPC.resize),
    onState: (cb: (state: TimerOverlayState) => void) => on<TimerOverlayState>(IPC_EVENTS.timerState, cb),
    onHover: (cb: (hovered: boolean) => void) => on<boolean>(IPC_EVENTS.timerHover, cb)
  },
  onFocusCapture: (cb: () => void) => on(IPC_EVENTS.focusCapture, cb)
} as unknown as Api & { onFocusCapture(cb: () => void): () => void }

// 顶部只显示信息，不给它任务、设置等写接口。
contextBridge.exposeInMainWorld('api', process.argv.includes('--planreview-timer') ? { timer: api.timer } : api)
