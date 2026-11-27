import { app, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import type { MainCommand, Reminder, Settings, TimeEntry } from '@shared/types'
import { hotkeyLabel } from '@shared/format'
import { resourcePath } from './windows'

const isMac = process.platform === 'darwin'

/** macOS 的全局菜单栏：Electron 默认菜单是英文的，这里换成中文，并保留编辑/窗口的标准角色 */
export function createAppMenu(showMain: () => void): void {
  if (!isMac) return
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about', label: '关于计划与复盘' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏计划与复盘' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出计划与复盘' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { label: '打开主窗口', click: showMain },
        { role: 'front', label: '前置全部窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com/Anthony-xyr/PlanReview')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export interface TraySnapshot {
  running: TimeEntry | null
  settings: Settings
  floatShown: boolean
  readyUpdateVersion: string | null
}

export interface TrayActions {
  showMain(): void
  toggleCapture(): void
  revealFloat(): void
  concealFloat(): void
  sendCommand(cmd: MainCommand): void
  requestUpdateRestart(): void
}

/** 封装系统托盘图标缓存、右键菜单与系统通知 */
export class DesktopTray {
  private tray: Tray | null = null
  private readonly iconCache = new Map<string, Electron.NativeImage>()

  constructor(private readonly actions: TrayActions) {}

  private icon(kind: 'idle' | 'running'): Electron.NativeImage {
    const file = isMac
      ? kind === 'running'
        ? 'tray-running-template.png'
        : 'tray-template.png'
      : kind === 'running'
        ? 'tray-running.png'
        : 'tray.png'
    const cached = this.iconCache.get(file)
    if (cached) return cached
    const img = nativeImage.createFromPath(resourcePath(file))
    if (isMac) img.setTemplateImage(true)
    this.iconCache.set(file, img)
    return img
  }

  create(initial: TraySnapshot): void {
    this.tray = new Tray(this.icon('idle'))
    this.tray.setToolTip('计划与复盘')
    // macOS 上点击托盘图标会直接弹出菜单（菜单第一项就是打开主窗口）；Windows 左键直接开窗口
    if (isMac) this.tray.setIgnoreDoubleClickEvents(true)
    else this.tray.on('click', () => this.actions.showMain())
    this.update(initial)
  }

  hasTray(): boolean {
    return this.tray !== null
  }

  update(state: TraySnapshot): void {
    if (!this.tray) return
    const { running, settings: s, floatShown, readyUpdateVersion } = state
    this.tray.setImage(this.icon(running ? 'running' : 'idle'))
    this.tray.setToolTip(running ? `计时中：${running.title}` : '计划与复盘')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开主窗口', click: () => this.actions.showMain() },
        { label: `速记（${hotkeyLabel(s.hotkey, process.platform)}）`, click: () => this.actions.toggleCapture() },
        ...(isMac
          ? [
              // 在另一个 Space 的窗口也可能被 Electron 视作可见，始终保留主动唤出的入口。
              { label: '显示悬浮窗', click: () => this.actions.revealFloat() },
              ...(floatShown ? [{ label: '隐藏悬浮窗', click: () => this.actions.concealFloat() }] : [])
            ]
          : [
              {
                label: floatShown ? '隐藏悬浮窗' : '显示悬浮窗',
                click: () => (floatShown ? this.actions.concealFloat() : this.actions.revealFloat())
              }
            ]),
        { type: 'separator' },
        ...(running ? [{ label: `结束本次：${running.title}`, click: () => this.actions.sendCommand('stop') }] : []),
        { label: '收尾', click: () => this.actions.sendCommand('wrap-up') },
        { label: '今日复盘', click: () => this.actions.sendCommand('review') },
        { label: '周复盘', click: () => this.actions.sendCommand('weekly') },
        { type: 'separator' },
        ...(readyUpdateVersion
          ? [
              {
                label: `重启并更新到 ${readyUpdateVersion}`,
                click: () => this.actions.requestUpdateRestart()
              }
            ]
          : []),
        { label: '退出', click: () => app.quit() }
      ])
    )
  }
}

/** 系统通知：悬浮窗不可见时（全屏、关掉了）也能看到；强提醒带声音 */
export function showReminderNotification(
  r: Reminder,
  s: Settings,
  floatVisible: boolean,
  onClick: () => void
): void {
  if (!Notification.isSupported()) return
  if (floatVisible && !r.strong) return
  const n = new Notification({
    title: r.title,
    body: r.body,
    silent: !(r.strong && s.strongSound),
    urgency: r.strong ? 'critical' : 'normal',
    // macOS 的通知不读自定义图标，直接显示应用图标
    ...(isMac ? {} : { icon: resourcePath('icon.png') })
  })
  n.on('click', onClick)
  n.show()
}
