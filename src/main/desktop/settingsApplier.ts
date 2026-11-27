import { app, globalShortcut, nativeTheme } from 'electron'
import type { Settings, SystemStatus } from '@shared/types'
import { isFullscreenAppActive } from '../native'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

/** 负责将全局快捷键、开机自启与主题偏好应用到系统层 */
export class SystemSettingsApplier {
  private hotkeyRegistered = false
  private registeredHotkey = ''

  constructor(
    private readonly onHotkey: () => void,
    private readonly onThemeApplied: () => void
  ) {}

  apply(s: Settings): void {
    if (s.hotkey !== this.registeredHotkey) {
      if (this.registeredHotkey) globalShortcut.unregister(this.registeredHotkey)
      try {
        this.hotkeyRegistered = globalShortcut.register(s.hotkey, this.onHotkey)
      } catch {
        this.hotkeyRegistered = false
      }
      this.registeredHotkey = this.hotkeyRegistered ? s.hotkey : ''
    }
    if (app.isPackaged) {
      // 只在状态变化时写系统登录项：每次启动都写的话，未签名的包会被 macOS 拒绝并打一条错误。
      // Windows 的登录项带 --hidden 参数；读取时必须传入同一组 args，否则 Electron 会认为
      // 该项不存在，取消勾选时就不会删除 Run 值。
      const current = app.getLoginItemSettings(isMac ? undefined : { args: ['--hidden'] }).openAtLogin
      if (current !== s.launchAtLogin) {
        // macOS 的登录项不接收启动参数，靠 wasOpenedAtLogin 判断；Windows 用 --hidden
        if (isMac) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
        else app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] })
      }
    }
    // 界面的深浅色走 CSS 的 prefers-color-scheme，这里定下它取系统的还是固定一种
    nativeTheme.themeSource = s.theme
    this.onThemeApplied()
  }

  status(): SystemStatus {
    return {
      hotkeyRegistered: this.hotkeyRegistered,
      fullscreenDetection: isWindows && isFullscreenAppActive() !== null,
      platform: isWindows ? 'win32' : isMac ? 'darwin' : 'linux'
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll()
  }
}
