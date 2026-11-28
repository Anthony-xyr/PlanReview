import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { ALL_IPC_CHANNELS, createInvokeBridge, ipcAccessOf, IPC_MANIFEST, TIMER_IPC } from '@shared/ipc'
import { createIpcRegistry } from './registry'
import { registerAppIpc } from './index'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function fakeIpc() {
  const map = new Map<string, Handler>()
  return {
    ipc: {
      handle(channel: string, listener: Handler) {
        map.set(channel, listener)
      }
    },
    invoke(channel: string, event: Partial<IpcMainInvokeEvent>, ...args: unknown[]) {
      const fn = map.get(channel)
      if (!fn) throw new Error(`missing channel: ${channel}`)
      return fn(event as IpcMainInvokeEvent, ...args)
    },
    channels: () => [...map.keys()]
  }
}

describe('IPC manifest & preload bridge', () => {
  it('按清单自动生成所有命名空间与 channel 调用', async () => {
    const calls: [string, unknown[]][] = []
    const bridge = createInvokeBridge(async (channel, ...args) => {
      calls.push([channel, args])
      return channel
    })
    expect(Object.keys(bridge)).toEqual(Object.keys(IPC_MANIFEST))
    expect(await bridge.tasks.list({ status: 'active' })).toBe('tasks:list')
    expect(await bridge.plan.create({ title: '自习' })).toBe('plan:create')
    expect(calls).toEqual([
      ['tasks:list', [{ status: 'active' }]],
      ['plan:create', [{ title: '自习' }]]
    ])
  })

  it('准确识别读写与窗口访问级别', () => {
    expect(ipcAccessOf('tasks:list')).toBe('read')
    expect(ipcAccessOf('tasks:create')).toBe('write')
    expect(ipcAccessOf('win:openMain')).toBe('window')
    expect(ipcAccessOf('win:resizeFloat')).toBe('window')
    expect(ipcAccessOf('win:floatReady')).toBe('window')
  })
})

describe('createIpcRegistry', () => {
  const mainSender = { id: 1 } as unknown as WebContents
  const floatSender = { id: 2 } as unknown as WebContents
  const timerSender = { id: 3 } as unknown as WebContents
  const eventFor = (sender: WebContents, isMainFrame = true): Partial<IpcMainInvokeEvent> => ({
    sender,
    senderFrame: (isMainFrame ? { main: true } : { main: false }) as unknown as IpcMainInvokeEvent['senderFrame']
  })

  it('按权限拦截计时器窗口与非悬浮窗调用，并只对写操作触发广播', async () => {
    const { ipc, invoke } = fakeIpc()
    const changed: WebContents[] = []
    const reg = createIpcRegistry(ipc, {
      isTimerSender: (s) => s === timerSender,
      isFloatMainFrame: (e) => e.sender === floatSender && Boolean((e.senderFrame as unknown as { main?: boolean })?.main),
      onDataChanged: (s) => changed.push(s)
    })

    reg.handle('tasks:list', () => ['ok'])
    reg.handle('tasks:create', () => 'sync-created')
    reg.handle('weekly:generate', async () => 'async-generated')
    reg.handle('win:showFloat', () => 'shown')
    reg.handle('win:resizeFloat', () => 'resized')

    expect(invoke('tasks:list', eventFor(mainSender))).toEqual(['ok'])
    expect(changed).toEqual([])

    expect(invoke('tasks:create', eventFor(mainSender))).toBe('sync-created')
    expect(changed).toEqual([mainSender])

    expect(await invoke('weekly:generate', eventFor(mainSender))).toBe('async-generated')
    expect(changed).toEqual([mainSender, mainSender])

    expect(invoke('win:showFloat', eventFor(mainSender))).toBe('shown')
    expect(changed).toHaveLength(2)

    expect(() => invoke('tasks:list', eventFor(timerSender))).toThrow('该窗口不能使用此通道')
    expect(() => invoke('win:resizeFloat', eventFor(mainSender))).toThrow('仅悬浮窗可使用此通道')
    expect(() => invoke('win:resizeFloat', eventFor(floatSender, false))).toThrow('仅悬浮窗可使用此通道')
    expect(invoke('win:resizeFloat', eventFor(floatSender, true))).toBe('resized')
  })

  it('拒绝重复注册与缺失通道', () => {
    const { ipc } = fakeIpc()
    const reg = createIpcRegistry(ipc, {
      isTimerSender: () => false,
      isFloatMainFrame: () => true,
      onDataChanged: () => {}
    })
    reg.handle('tasks:list', () => [])
    expect(() => reg.handle('tasks:list', () => [])).toThrow(/重复注册/)
    expect(() => reg.assertComplete()).toThrow(/缺少未注册/)
  })

  it('registerAppIpc 完整注册清单内所有业务通道与顶部计时器通道', () => {
    const { ipc, channels } = fakeIpc()
    registerAppIpc(ipc, {
      repo: {} as never,
      time: {} as never,
      courses: {} as never,
      review: {} as never,
      weekly: {} as never,
      habits: {} as never,
      plannerHabits: {} as never,
      aiConfig: {} as never,
      ai: {} as never,
      center: {} as never,
      updateSettings: vi.fn() as never,
      openMain: vi.fn(),
      showFloat: vi.fn(),
      hideFloat: vi.fn(),
      floatReady: vi.fn(),
      resizeFloat: vi.fn(),
      status: vi.fn() as never,
      timer: { accepts: () => true, snapshot: vi.fn() as never, resize: vi.fn() },
      guards: { isTimerSender: () => false, isFloatMainFrame: () => true, onDataChanged: vi.fn() }
    })
    const registered = new Set(channels())
    for (const ch of ALL_IPC_CHANNELS) expect(registered.has(ch)).toBe(true)
    expect(registered.has(TIMER_IPC.state)).toBe(true)
    expect(registered.has(TIMER_IPC.resize)).toBe(true)
  })
})

// 覆盖层与普通悬浮窗共用window通道，必须分别验证发送方和禁止写广播。
it('接受overlay主帧并传递窗口事件，拒绝其他窗口/子帧，两个window通道均不广播', () => {
  const { ipc, invoke } = fakeIpc()
  const frame = {}
  const overlay = { mainFrame: frame } as unknown as WebContents
  const ordinary = { mainFrame: {} } as unknown as WebContents
  const timer = { mainFrame: {} } as unknown as WebContents
  const changed = vi.fn()
  const ready = vi.fn()
  const resize = vi.fn()
  const reg = createIpcRegistry(ipc, {
    isTimerSender: sender => sender === timer,
    isFloatMainFrame: e => (e.sender === overlay || e.sender === ordinary) && e.senderFrame === e.sender.mainFrame,
    onDataChanged: changed
  })
  reg.handleWindow('win:floatReady', ready)
  reg.handleWindow('win:resizeFloat', resize)
  for (const sender of [overlay, ordinary]) {
    const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent
    invoke('win:floatReady', event)
    invoke('win:resizeFloat', event, 240)
    expect(ready).toHaveBeenCalledWith(event)
    expect(resize).toHaveBeenCalledWith(event, 240)
    for (const channel of ['win:floatReady', 'win:resizeFloat']) {
      expect(() => invoke(channel, { sender, senderFrame: {} as never })).toThrow('仅悬浮窗')
      expect(() => invoke(channel, { sender: { mainFrame: {} } as never })).toThrow('仅悬浮窗')
      expect(() => invoke(channel, { sender: timer, senderFrame: timer.mainFrame })).toThrow('该窗口不能')
    }
  }
  expect(changed).not.toHaveBeenCalled()
})
