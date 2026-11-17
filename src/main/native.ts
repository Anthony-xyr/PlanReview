import { createRequire } from 'node:module'

// Windows 的「用户通知状态」：全屏游戏、全屏视频、演示模式时返回 2/3/4。
// 用来在全屏时自动隐藏悬浮窗。失败时返回 null（视为无法检测）。
//
// macOS 不需要这个检测：全屏应用会占一个独立的桌面（Space），悬浮窗不设
// visibleOnFullScreen 就不会跟过去，effect 上等价于「全屏时隐藏」。
// koffi 只在 Windows 上加载，其他平台缺这个原生模块也不影响启动。
type QueryFn = (out: number[]) => number
let query: QueryFn | null | undefined

interface Koffi {
  load(path: string): { func(signature: string): unknown }
}

function loadQuery(): QueryFn | null {
  if (process.platform !== 'win32') return null
  if (query !== undefined) return query
  try {
    // 打包后是 CJS；开发时 electron-vite 也可能输出 ESM，两种都兜住
    const req = typeof __filename === 'string' ? createRequire(__filename) : createRequire(import.meta.url)
    const koffi = req('koffi') as Koffi
    const shell32 = koffi.load('shell32.dll')
    query = shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *state)') as QueryFn
  } catch {
    query = null
  }
  return query
}

export function isFullscreenAppActive(): boolean | null {
  const fn = loadQuery()
  if (!fn) return null
  try {
    const out = [0]
    if (fn(out) !== 0) return null
    return out[0] === 2 || out[0] === 3 || out[0] === 4
  } catch {
    query = null
    return null
  }
}
