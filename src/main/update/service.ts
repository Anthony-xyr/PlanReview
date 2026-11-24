import { randomUUID } from 'node:crypto'
import type { UpdateState } from '@shared/update'
import { releaseNotes } from './releaseNotes'
import { updateErrorText, updateFailure } from './log'
import type { CheckPreferences } from './preferences'
import { isNewerStable, stableVersion } from './version'

export const FIRST_CHECK_MS = 15_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000

export interface UpdatePort {
  check(signal: AbortSignal): Promise<{ version: string; notes?: string | null } | null>
  download?(progress: (percent: number) => void, signal: AbortSignal): Promise<void>
  installNow?(): void
}

export interface UpdateClock {
  now(): Date
  after(delay: number, callback: () => void): () => void
}

const realClock: UpdateClock = {
  now: () => new Date(),
  after: (delay, callback) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  }
}

export function updateMode(platform: NodeJS.Platform, isPackaged: boolean): UpdateState['mode'] {
  return !isPackaged ? 'development' : platform === 'win32' ? 'download' : platform === 'darwin' ? 'check-only' : 'unsupported-platform'
}

interface Options {
  currentVersion: string
  installedVersion?: string | null
  mode: UpdateState['mode']
  prefs: CheckPreferences
  port?: UpdatePort
  publish: (state: UpdateState) => void
  log: (event: string) => void
  clock?: UpdateClock
}

export class UpdaterService {
  private state: UpdateState
  private cancelTimer: (() => void) | undefined
  private clock: UpdateClock
  private active: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private manual = false
  private started = false
  private disposed = false

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? realClock
    this.state = {
      runId: randomUUID(), currentVersion: options.currentVersion, installedVersion: options.installedVersion ?? null,
      mode: options.mode, autoCheck: options.prefs.enabled(), lastCheckedAt: options.prefs.lastCheckedAt(),
      status: options.port && (options.mode === 'download' || options.mode === 'check-only') ? 'idle' : 'unsupported',
      release: null, percent: null, error: null
    }
  }

  snapshot(): UpdateState { return this.state }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.schedule(FIRST_CHECK_MS)
  }

  dispose(): void {
    this.disposed = true
    this.cancellation?.abort()
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  private schedule(delay: number): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    if (!this.started || this.disposed || !this.state.autoCheck || this.state.status === 'unsupported') return
    this.cancelTimer = this.clock.after(delay, () => {
      this.cancelTimer = undefined
      if (!this.state.autoCheck || this.disposed) return
      this.schedule(CHECK_INTERVAL_MS)
      void this.check('automatic')
    })
  }

  setAutoCheck(enabled: boolean): void {
    if (this.disposed || this.state.autoCheck === enabled) return
    this.options.prefs.setEnabled(enabled)
    if (!enabled && !this.manual) this.cancellation?.abort()
    this.patch({ autoCheck: enabled })
    this.schedule(FIRST_CHECK_MS)
  }

  check(trigger: 'manual' | 'automatic'): Promise<void> {
    if (this.disposed || this.state.status === 'unsupported' || this.state.status === 'downloaded' ||
        (trigger === 'automatic' && !this.state.autoCheck)) return Promise.resolve()
    if (this.active && this.cancellation?.signal.aborted) {
      return trigger === 'manual' ? this.active.then(() => this.check(trigger)) : this.active
    }
    if (trigger === 'manual') this.manual = true
    if (this.active) return this.active
    // 先占位，同一时间最多一次联网操作。在下载完成前也不重复检查。
    const previous = this.state
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.active = Promise.resolve().then(() => this.run(previous, cancellation.signal)).finally(() => {
      this.active = undefined
      this.cancellation = undefined
      this.manual = false
    })
    return this.active
  }

  readyVersion(): string | null {
    return this.state.mode === 'download' && this.state.status === 'downloaded' ? this.state.release?.version ?? null : null
  }

  installNow(): void {
    if (!this.readyVersion() || !this.options.port?.installNow) throw new Error('没有已下载的更新。')
    this.options.port.installNow()
  }

  private patch(patch: Partial<UpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    try { this.options.publish(this.state) } catch { this.options.log('status delivery failed') }
  }

  private async run(previous: UpdateState, signal: AbortSignal): Promise<void> {
    // 如果在自动检查真正开始前关闭了开关，不执行这次检查。
    if (signal.aborted) return
    let downloading = false
    const at = this.clock.now().toISOString()
    this.patch({ status: 'checking', release: null, percent: null, error: null, lastCheckedAt: at })
    this.options.log(this.manual ? 'manual check started' : 'automatic check started')
    try {
      try { this.options.prefs.recordCheck(at) } catch { this.options.log('could not save check time') }
      const available = await this.options.port!.check(signal)
      signal.throwIfAborted()
      if (!available || !isNewerStable(available.version, this.state.currentVersion)) {
        this.patch({ status: 'current' })
        this.options.log('no newer stable release')
        return
      }
      const version = stableVersion(available.version)!
      const notes = await releaseNotes(available.notes).catch(() => {
        this.options.log('release notes unreadable')
        return { notes: '', notesTruncated: false }
      })
      signal.throwIfAborted()
      this.patch({ status: 'available', release: { version, ...notes } })
      this.options.log('new stable release available')
      if (this.state.mode !== 'download') return
      downloading = true
      this.patch({ status: 'downloading', percent: 0 })
      await this.options.port!.download!((value) => {
        if (!Number.isFinite(value) || this.state.status !== 'downloading') return
        const percent = Math.max(0, Math.min(100, Math.floor(value)))
        if (percent > (this.state.percent ?? 0)) this.patch({ percent })
      }, signal)
      signal.throwIfAborted()
      this.patch({ status: 'downloaded', percent: 100 })
      this.options.log('download verified and ready')
    } catch (error) {
      if (signal.aborted) this.options.log('background update cancelled')
      else this.options.log(`${this.manual ? 'manual' : 'automatic'} ${downloading ? 'download' : 'check'} failed ${updateFailure(error, downloading)}`)
      if (this.manual && !signal.aborted) this.patch({ status: 'error', percent: null, error: updateErrorText(error, downloading) })
      else this.patch({ status: previous.status, release: previous.release, percent: previous.percent, error: previous.error })
    }
  }
}
