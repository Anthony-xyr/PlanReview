import { randomUUID } from 'node:crypto'
import type { UpdateConfirmation } from '@shared/update'

export const CONFIRMATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type RunningTimer = { id: string; title: string }

interface RestartActions {
  readyVersion(): string | null
  running(): RunningTimer | null
  isQuitting(): boolean
  showMain(): void
  publish(): void
  install(version: string): void
}

/** 一个待确认请求只授权当前下载版本和当时看到的计时。 */
export class UpdateRestart {
  private pending: { prompt: UpdateConfirmation; timerId: string } | null = null

  constructor(private readonly actions: RestartActions) {}

  confirmation(): UpdateConfirmation | null {
    return this.pending?.prompt ?? null
  }

  request(source: 'main' | 'tray'): void {
    if (this.actions.isQuitting()) return
    const version = this.actions.readyVersion()
    if (!version) {
      this.invalidate()
      throw new Error('没有已下载的更新。')
    }
    const running = this.actions.running()
    if (!running) {
      this.invalidate()
      this.actions.install(version)
      return
    }
    if (source === 'tray') this.actions.showMain()
    this.setConfirmation(version, running, source)
  }

  respond(id: string, accept: boolean): void {
    const pending = this.pending
    if (!pending || pending.prompt.id !== id || this.actions.isQuitting()) {
      throw new Error('更新确认已失效，请重新选择「重启并更新」。')
    }
    if (!accept) {
      this.invalidate()
      return
    }
    const version = this.actions.readyVersion()
    if (!version || version !== pending.prompt.version) {
      this.invalidate()
      throw new Error('待安装的更新已变化，请重新检查。')
    }
    const running = this.actions.running()
    // 如果用户从其他入口切换了计时，必须先让用户看到新的任务名。
    if (running && (running.id !== pending.timerId || running.title !== pending.prompt.timerTitle)) {
      this.setConfirmation(version, running, pending.prompt.source)
      return
    }
    // 停止计时不会触发安装。已经明确点了确认时，可以安装且保留已结束的记录。
    this.invalidate()
    this.actions.install(version)
  }

  invalidate(): void {
    if (!this.pending) return
    this.pending = null
    this.actions.publish()
  }

  /** 随更新状态一起发布，确保状态和确认在主窗口的同一份快照中。 */
  syncReadyVersion(): void {
    if (this.pending && this.pending.prompt.version !== this.actions.readyVersion()) this.pending = null
  }

  private setConfirmation(version: string, running: RunningTimer, source: UpdateConfirmation['source']): void {
    this.pending = { prompt: { id: randomUUID(), version, timerTitle: running.title, source }, timerId: running.id }
    this.actions.publish()
  }
}

/** 允许请求伴随新主窗口首次加载，之后跨文档导航都会废弃旧确认。 */
export function updateConfirmationNavigation(invalidate: () => void) {
  let startedMainDocument = false
  return ({ isMainFrame, isSameDocument }: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (!isMainFrame || isSameDocument) return
    if (startedMainDocument) invalidate()
    else startedMainDocument = true
  }
}
