import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { ALL_IPC_CHANNELS, ipcAccessOf, type IpcChannel } from '@shared/ipc'

export interface IpcRegistryGuards {
  isTimerSender(sender: WebContents): boolean
  isFloatMainFrame(event: IpcMainInvokeEvent): boolean
  onDataChanged(sender: WebContents): void
}

export interface IpcRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: IpcChannel, fn: (...args: any[]) => unknown): void
  assertComplete(): void
}

/**
 * 统一的 IPC 注册器：依据 IPC_MANIFEST 自动应用窗口权限拦截与写操作广播，
 * 避免各模块重复写校验或遗漏集中式只读白名单。
 */
export function createIpcRegistry(ipc: Pick<IpcMain, 'handle'>, guards: IpcRegistryGuards): IpcRegistry {
  const registered = new Set<IpcChannel>()
  return {
    handle(channel, fn) {
      if (registered.has(channel)) throw new Error(`重复注册 IPC 通道：${channel}`)
      registered.add(channel)
      const access = ipcAccessOf(channel)
      ipc.handle(channel, (event, ...args) => {
        if (guards.isTimerSender(event.sender)) throw new Error('该窗口不能使用此通道')
        if (access === 'float' && !guards.isFloatMainFrame(event)) throw new Error('仅悬浮窗可使用此通道')
        const result = fn(...args)
        if (access === 'write') {
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            return (result as Promise<unknown>).then((value) => {
              guards.onDataChanged(event.sender)
              return value
            })
          }
          guards.onDataChanged(event.sender)
        }
        return result
      })
    },
    assertComplete() {
      const missing = ALL_IPC_CHANNELS.filter((ch) => !registered.has(ch))
      if (missing.length) throw new Error(`缺少未注册的 IPC 通道：${missing.join(', ')}`)
    }
  }
}
