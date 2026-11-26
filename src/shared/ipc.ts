/**
 * 主进程与预加载脚本共用的 IPC 契约清单（单一事实源）。
 * - read：只读查询，不触发 data-changed 广播
 * - write：写操作，成功后自动向其他窗口广播 data-changed 并重算提醒
 * - window：窗口控制，不触发数据广播
 * - float：仅悬浮窗主帧可调用，不触发数据广播
 */
export type IpcAccess = 'read' | 'write' | 'window' | 'float'

export const IPC_MANIFEST = {
  tasks: {
    list: 'read',
    get: 'read',
    capture: 'write',
    create: 'write',
    update: 'write',
    remove: 'write',
    spinOff: 'write',
    lineage: 'read'
  },
  categories: {
    list: 'read',
    create: 'write',
    update: 'write',
    remove: 'write',
    reorder: 'write',
    openCounts: 'read'
  },
  tags: {
    list: 'read'
  },
  plan: {
    list: 'read',
    startedIds: 'read',
    create: 'write',
    copy: 'write',
    update: 'write',
    remove: 'write'
  },
  entries: {
    list: 'read',
    create: 'write',
    update: 'write',
    remove: 'write',
    running: 'read',
    start: 'write',
    stop: 'write',
    extend: 'write',
    setTarget: 'write',
    setReason: 'write'
  },
  settings: {
    get: 'read',
    update: 'write'
  },
  ai: {
    getConfig: 'read',
    setConfig: 'write',
    test: 'read',
    parseCapture: 'read',
    reparseCapture: 'read',
    parseSchedule: 'read'
  },
  habits: {
    list: 'read',
    add: 'write',
    update: 'write',
    remove: 'write',
    markUsed: 'write'
  },
  courses: {
    list: 'read',
    commit: 'write',
    removeAll: 'write'
  },
  resurface: {
    get: 'read',
    act: 'write',
    reroll: 'write',
    dismissTidy: 'write'
  },
  review: {
    summary: 'read',
    save: 'write'
  },
  weekly: {
    stats: 'read',
    activeWeeks: 'read',
    get: 'read',
    generate: 'write',
    ask: 'write',
    apply: 'write',
    dismiss: 'write'
  },
  insights: {
    list: 'read',
    update: 'write',
    remove: 'write'
  },
  planner: {
    suggest: 'read',
    accept: 'write'
  },
  reminders: {
    current: 'read',
    dismiss: 'write',
    snooze: 'write'
  },
  win: {
    openMain: 'window',
    showFloat: 'window',
    hideFloat: 'window',
    floatReady: 'float',
    resizeFloat: 'float',
    status: 'read'
  }
} as const satisfies Record<string, Record<string, IpcAccess>>

export type IpcNamespace = keyof typeof IPC_MANIFEST
export type IpcMethod<N extends IpcNamespace> = Extract<keyof (typeof IPC_MANIFEST)[N], string>
export type IpcChannel = { [N in IpcNamespace]: `${N}:${IpcMethod<N>}` }[IpcNamespace]

export const IPC_EVENTS = {
  dataChanged: 'data-changed',
  command: 'command',
  reminder: 'reminder',
  focusCapture: 'focus-capture',
  timerState: 'timer-state',
  timerHover: 'timer-hover'
} as const

export const TIMER_IPC = {
  state: 'timer:state',
  resize: 'timer:resize'
} as const

export const ALL_IPC_CHANNELS: IpcChannel[] = (Object.keys(IPC_MANIFEST) as IpcNamespace[]).flatMap((ns) =>
  Object.keys(IPC_MANIFEST[ns]).map((method) => `${ns}:${method}` as IpcChannel)
)

export function ipcAccessOf(channel: IpcChannel): IpcAccess {
  const [ns, method] = channel.split(':') as [IpcNamespace, string]
  return (IPC_MANIFEST[ns] as Record<string, IpcAccess>)[method]
}

/** 供 preload 按清单自动生成按命名空间分组的 invoke 桥接对象 */
export function createInvokeBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): Record<IpcNamespace, Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const bridge = {} as Record<IpcNamespace, Record<string, (...args: unknown[]) => Promise<unknown>>>
  for (const ns of Object.keys(IPC_MANIFEST) as IpcNamespace[]) {
    const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const method of Object.keys(IPC_MANIFEST[ns])) {
      const channel = `${ns}:${method}`
      group[method] = (...args: unknown[]) => invoke(channel, ...args)
    }
    bridge[ns] = group
  }
  return bridge
}
