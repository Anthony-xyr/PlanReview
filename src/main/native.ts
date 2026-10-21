import koffi from 'koffi'

// Windows 的「用户通知状态」：全屏游戏、全屏视频、演示模式时返回 2/3/4。
// 用来在全屏时自动隐藏悬浮窗。失败时返回 null（视为无法检测）。
type QueryFn = (out: number[]) => number
let query: QueryFn | null | undefined

export function isFullscreenAppActive(): boolean | null {
  if (process.platform !== 'win32') return null
  try {
    if (query === undefined) {
      const shell32 = koffi.load('shell32.dll')
      query = shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *state)') as QueryFn
    }
    if (!query) return null
    const out = [0]
    if (query(out) !== 0) return null
    return out[0] === 2 || out[0] === 3 || out[0] === 4
  } catch {
    query = null
    return null
  }
}
