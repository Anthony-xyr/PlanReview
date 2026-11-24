import { randomUUID } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { UPDATE_IPC } from '@shared/update'
import { registerUpdateConfirmationIpc } from './ipc'
import { UpdateRestart, updateConfirmationNavigation } from './restart'

const firstTimer = { id: 'timer-1', title: '正在写复盘' }
function setup(running: typeof firstTimer | null = firstTimer) {
  const input = { version: '0.3.0' as string | null, running, quitting: false, visible: false }
  const publish = vi.fn()
  const install = vi.fn()
  const showMain = vi.fn(() => { input.visible = true })
  const restart = new UpdateRestart({
    readyVersion: () => input.version, running: () => input.running, isQuitting: () => input.quitting,
    showMain, publish, install
  })
  const request = (source: 'main' | 'tray' = 'main') => {
    restart.request(source)
    return restart.confirmation()!
  }
  return { input, restart, install, publish, showMain, request }
}

describe('主进程更新确认', () => {
  it('没有正在计时的任务时直接安装，不显示确认', () => {
    const { restart, install, request, publish, showMain } = setup(null)
    request('main')
    expect(restart.confirmation()).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    expect(showMain).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledExactlyOnceWith('0.3.0')
  })

  it('有计时先发布任务和版本，真实确认后才安装，请求只能用一次', () => {
    const { restart, install, request, publish, showMain } = setup()
    const prompt = request()
    expect(prompt).toMatchObject({ version: '0.3.0', timerTitle: firstTimer.title, source: 'main' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(showMain).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    restart.respond(prompt.id, true)
    expect(restart.confirmation()).toBeNull()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenCalledExactlyOnceWith('0.3.0')
    expect(() => restart.respond(prompt.id, true)).toThrow('已失效')
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('取消不安装，保留计时和待安装的版本，可以重试', () => {
    const { input, restart, install, request } = setup()
    const prompt = request()
    restart.respond(prompt.id, false)
    expect(restart.confirmation()).toBeNull()
    expect(input.running).toBe(firstTimer)
    expect(input.version).toBe(prompt.version)
    expect(install).not.toHaveBeenCalled()
    expect(request().id).not.toBe(prompt.id)
    expect(() => restart.respond(prompt.id, true)).toThrow('已失效')
  })

  it('重复请求替换编号，过期的确认或取消不会影响新请求', () => {
    const { restart, install, request } = setup()
    const first = request()
    const second = request()
    expect(first.id).not.toBe(second.id)
    expect(() => restart.respond(first.id, true)).toThrow('已失效')
    expect(() => restart.respond(first.id, false)).toThrow('已失效')
    expect(restart.confirmation()).toBe(second)
    expect(install).not.toHaveBeenCalled()
  })

  it('确认框打开期间停止计时不自动安装，点击确认后才更新', () => {
    const { input, restart, install, request } = setup()
    const prompt = request()
    input.running = null
    expect(restart.confirmation()).toBe(prompt)
    expect(install).not.toHaveBeenCalled()
    restart.respond(prompt.id, true)
    expect(install).toHaveBeenCalledExactlyOnceWith('0.3.0')
  })

  it('确认前切换计时必须展示新任务，旧确认不会安装', () => {
    const { input, restart, install, request } = setup()
    const first = request()
    input.running = { id: 'timer-2', title: '接着读资料' }
    restart.respond(first.id, true)
    const next = restart.confirmation()!
    expect(next.id).not.toBe(first.id)
    expect(next.timerTitle).toBe('接着读资料')
    expect(install).not.toHaveBeenCalled()
    restart.respond(next.id, true)
    expect(install).toHaveBeenCalledExactlyOnceWith('0.3.0')
  })

  it.each([null, '0.3.1'])('下载就绪状态变为 %s 时废弃旧请求', (nextVersion) => {
    const { input, restart, install, request } = setup()
    const prompt = request()
    input.version = nextVersion
    restart.syncReadyVersion()
    expect(restart.confirmation()).toBeNull()
    input.version = prompt.version
    expect(() => restart.respond(prompt.id, true)).toThrow('已失效')
    expect(install).not.toHaveBeenCalled()
  })

  it('确认瞬间再次判断待安装版本，即使更新事件尚未送达', () => {
    const { input, restart, install, request } = setup()
    const prompt = request()
    input.version = null
    expect(() => restart.respond(prompt.id, true)).toThrow('已变化')
    expect(restart.confirmation()).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(() => restart.request('tray')).toThrow('没有已下载')
  })

  it('初次加载可以接收托盘请求，主窗口重载废弃旧确认', () => {
    const { restart, install, request } = setup()
    const navigation = updateConfirmationNavigation(() => restart.invalidate())
    const prompt = request('tray')
    navigation({ isMainFrame: true, isSameDocument: false })
    expect(restart.confirmation()).toBe(prompt)
    navigation({ isMainFrame: false, isSameDocument: false })
    navigation({ isMainFrame: true, isSameDocument: true })
    expect(restart.confirmation()).toBe(prompt)
    navigation({ isMainFrame: true, isSameDocument: false })
    expect(restart.confirmation()).toBeNull()
    expect(() => restart.respond(prompt.id, true)).toThrow('已失效')
    expect(install).not.toHaveBeenCalled()
  })

  it('拒绝伪造编号和退出期间的确认', () => {
    const { input, restart, install, request } = setup()
    const prompt = request()
    expect(() => restart.respond(randomUUID(), true)).toThrow('已失效')
    expect(restart.confirmation()).toBe(prompt)
    input.quitting = true
    expect(() => restart.respond(prompt.id, true)).toThrow('已失效')
    expect(install).not.toHaveBeenCalled()
  })

  it('正在计时时托盘先唤出隐藏的主窗口，再发布确认', () => {
    const { input, install, request, publish, showMain } = setup()
    expect(input.visible).toBe(false)
    publish.mockImplementation(() => { expect(input.visible).toBe(true) })
    expect(request('tray').source).toBe('tray')
    expect(showMain).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
  })
})

it('确认通信只允许主窗口主帧发送一次性编号和布尔选择', () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = { handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => { handlers.set(channel, handler) } }
  const main = { mainFrame: {} } as WebContents
  const ok = { sender: main, senderFrame: main.mainFrame } as IpcMainInvokeEvent
  const respond = vi.fn()
  registerUpdateConfirmationIpc(ipc, () => main, respond)
  expect([...handlers.keys()]).toEqual([UPDATE_IPC.respondToRestart])
  const handle = handlers.get(UPDATE_IPC.respondToRestart)!
  const id = randomUUID()
  for (const event of [{ sender: {} }, { sender: main, senderFrame: null }, { sender: main, senderFrame: {} }]) {
    expect(() => handle(event as IpcMainInvokeEvent, id, true)).toThrow('仅主窗口')
  }
  for (const args of [[], [id], [id, 'yes'], ['https://example.test/', true], ['C:/update.exe', true], [id, true, 'extra']]) {
    expect(() => handle(ok, ...args)).toThrow('参数不正确')
  }
  expect(respond).not.toHaveBeenCalled()
  handle(ok, id, true)
  expect(respond).toHaveBeenCalledExactlyOnceWith(id, true)
})
