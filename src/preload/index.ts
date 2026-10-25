import { contextBridge, ipcRenderer } from 'electron'
import type { Api, MainCommand, Reminder } from '@shared/types'

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

const api: Api & { onFocusCapture(cb: () => void): () => void } = {
  tasks: {
    list: call('tasks:list'),
    get: call('tasks:get'),
    capture: call('tasks:capture'),
    create: call('tasks:create'),
    update: call('tasks:update'),
    remove: call('tasks:remove'),
    spinOff: call('tasks:spinOff'),
    lineage: call('tasks:lineage')
  } as Api['tasks'],
  categories: {
    list: call('categories:list'),
    create: call('categories:create'),
    update: call('categories:update'),
    remove: call('categories:remove'),
    reorder: call('categories:reorder'),
    openCounts: call('categories:openCounts')
  } as Api['categories'],
  tags: { list: call('tags:list') } as Api['tags'],
  plan: {
    list: call('plan:list'),
    create: call('plan:create'),
    update: call('plan:update'),
    remove: call('plan:remove')
  } as Api['plan'],
  entries: {
    list: call('entries:list'),
    create: call('entries:create'),
    update: call('entries:update'),
    remove: call('entries:remove'),
    running: call('entries:running'),
    start: call('entries:start'),
    stop: call('entries:stop'),
    extend: call('entries:extend'),
    setTarget: call('entries:setTarget'),
    setReason: call('entries:setReason')
  } as Api['entries'],
  settings: { get: call('settings:get'), update: call('settings:update') } as Api['settings'],
  reminders: {
    current: call('reminders:current'),
    dismiss: call('reminders:dismiss'),
    snooze: call('reminders:snooze'),
    onChange: (cb: (r: Reminder | null) => void) => on('reminder', cb)
  } as Api['reminders'],
  events: {
    onDataChanged: (cb: () => void) => on('data-changed', cb),
    onCommand: (cb: (cmd: MainCommand) => void) => on('command', cb)
  },
  win: {
    openMain: call('win:openMain'),
    showFloat: call('win:showFloat'),
    hideFloat: call('win:hideFloat'),
    resizeFloat: call('win:resizeFloat'),
    status: call('win:status')
  } as Api['win'],
  ai: {
    getConfig: call('ai:getConfig'),
    setConfig: call('ai:setConfig'),
    test: call('ai:test'),
    parseCapture: call('ai:parseCapture'),
    reparseCapture: call('ai:reparseCapture'),
    parseSchedule: call('ai:parseSchedule')
  } as Api['ai'],
  habits: {
    list: call('habits:list'),
    add: call('habits:add'),
    update: call('habits:update'),
    remove: call('habits:remove'),
    markUsed: call('habits:markUsed')
  } as Api['habits'],
  courses: {
    list: call('courses:list'),
    commit: call('courses:commit'),
    removeAll: call('courses:removeAll')
  } as Api['courses'],
  resurface: {
    get: call('resurface:get'),
    act: call('resurface:act'),
    reroll: call('resurface:reroll'),
    dismissTidy: call('resurface:dismissTidy')
  } as Api['resurface'],
  review: {
    summary: call('review:summary'),
    save: call('review:save')
  } as Api['review'],
  weekly: {
    stats: call('weekly:stats'),
    activeWeeks: call('weekly:activeWeeks'),
    get: call('weekly:get'),
    generate: call('weekly:generate'),
    ask: call('weekly:ask'),
    apply: call('weekly:apply'),
    dismiss: call('weekly:dismiss')
  } as Api['weekly'],
  insights: {
    list: call('insights:list'),
    update: call('insights:update'),
    remove: call('insights:remove')
  } as Api['insights'],
  planner: {
    suggest: call('planner:suggest'),
    accept: call('planner:accept')
  } as Api['planner'],
  onFocusCapture: (cb: () => void) => on('focus-capture', cb)
}

contextBridge.exposeInMainWorld('api', api)
