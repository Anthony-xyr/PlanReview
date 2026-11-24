import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { UPDATE_IPC, RELEASES_URL, type UpdateState } from '@shared/update'

interface Actions {
  state(): UpdateState
  check(): Promise<void>
  setAutoCheck(enabled: boolean): void
  restart(): Promise<void>
  openExternal(url: string): Promise<void>
}

export function registerUpdateIpc(ipc: Pick<IpcMain, 'handle'>, mainContents: () => WebContents | undefined, actions: Actions): void {
  const mainOnly = (event: IpcMainInvokeEvent) => {
    const main = mainContents()
    if (!main || event.sender !== main || !event.senderFrame || event.senderFrame !== main.mainFrame) {
      throw new Error('仅主窗口可使用软件更新。')
    }
  }
  const noArgs = (channel: string, action: () => unknown) => ipc.handle(channel, (event, ...args: unknown[]) => {
    mainOnly(event)
    if (args.length) throw new Error('软件更新请求参数不正确。')
    return action()
  })
  noArgs(UPDATE_IPC.state, () => actions.state())
  noArgs(UPDATE_IPC.check, () => actions.check())
  noArgs(UPDATE_IPC.openReleases, () => actions.openExternal(RELEASES_URL))
  noArgs(UPDATE_IPC.restart, () => actions.restart())
  ipc.handle(UPDATE_IPC.setAutoCheck, (event, ...args: unknown[]) => {
    mainOnly(event)
    if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('自动检查更新的开关只能是开或关。')
    return actions.setAutoCheck(args[0])
  })
}
