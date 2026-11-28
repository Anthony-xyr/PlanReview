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
  handleWindow(channel: IpcChannel, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  assertComplete(): void
}

/**
 * 统一的 IPC 注册器：依据 IPC_MANIFEST 自动应用窗口权限拦截与写操作广播，
 * 避免各模块重复写校验或遗漏集中式只读白名单。
 */
export function createIpcRegistry(ipc: Pick<IpcMain, 'handle'>, guards: IpcRegistryGuards): IpcRegistry {
  const registered = new Set<IpcChannel>()
  const register = (channel: IpcChannel, fn: (...args: any[]) => unknown, withEvent = false): void => {
    if (registered.has(channel)) throw new Error(`重复注册 IPC 通道：${channel}`)
    registered.add(channel)
    const access = ipcAccessOf(channel)
    ipc.handle(channel, (event, ...args) => {
      if (guards.isTimerSender(event.sender)) throw new Error('该窗口不能使用此通道')
      if ((access === 'float' || channel === 'win:floatReady' || channel === 'win:resizeFloat') && !guards.isFloatMainFrame(event)) throw new Error('仅悬浮窗可使用此通道')
      const result = withEvent ? fn(event, ...args) : fn(...args)
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
  }
  return {
    handle: (channel, fn) => register(channel, fn),
    handleWindow(channel, fn) {
      if (ipcAccessOf(channel) !== 'window') throw new Error('仅窗口通道可接收窗口事件')
      register(channel, fn, true)
    },
    assertComplete() {
      const missing = ALL_IPC_CHANNELS.filter((ch) => !registered.has(ch))
      if (missing.length) throw new Error(`缺少未注册的 IPC 通道：${missing.join(', ')}`)
    }
  }
}
