import type { Api } from '@shared/types'

declare global {
  interface Window {
    api: Api & {
      /** 悬浮窗：全局快捷键唤起时聚焦速记框 */
      onFocusCapture(cb: () => void): () => void
    }
  }
}
