import type { DatabaseSync } from 'node:sqlite'
import { app, ipcMain, shell, type WebContents } from 'electron'
import type { TimeEntry } from '@shared/types'
import { UPDATE_IPC, type UpdateSnapshot } from '@shared/update'
import { macReleaseChecker, windowsUpdater } from './adapters'
import { snapshotBeforeUpdate } from './backup'
import { prepareUpdateExit } from './exit'
import { registerUpdateConfirmationIpc, registerUpdateIpc } from './ipc'
import { updaterLog } from './log'
import { UpdatePreferences } from './preferences'
import { UpdateRestart } from './restart'
import { UpdaterService, updateMode } from './service'

export interface UpdateRuntimeDeps {
  db: DatabaseSync
  running(): TimeEntry | null
  mainContents(): WebContents | undefined
  showMain(): void
  isQuitting(): boolean
  setQuitting(value: boolean): void
  onReadyVersionChanged(): void
}

/** 封装软件更新服务、重启确认流程、退出前备份与 IPC 注册 */
export class UpdateRuntime {
  private readonly service: UpdaterService
  private readonly prefs: UpdatePreferences
  private readonly restart: UpdateRestart
  private readonly log: (event: string) => void
  private readonly db: DatabaseSync
  private readonly deps: UpdateRuntimeDeps
  private trayUpdateVersion: string | null = null
  private exitSaved = false

  constructor(deps: UpdateRuntimeDeps) {
    this.deps = deps
    this.db = deps.db
    const version = app.getVersion()
    const mode = updateMode(process.platform, app.isPackaged)
    this.prefs = new UpdatePreferences(deps.db)
    this.log = app.isPackaged ? updaterLog(app.getPath('userData')) : () => {}

    let installedVersion: string | null = null
    if (app.isPackaged) {
      try { installedVersion = this.prefs.recordStartup(version) }
      catch { this.log('could not record first startup version') }
    }

    this.service = new UpdaterService({
      currentVersion: version,
      installedVersion,
      mode,
      prefs: this.prefs,
      port: mode === 'download' ? windowsUpdater(this.log) : mode === 'check-only' ? macReleaseChecker() : undefined,
      publish: () => {
        this.restart.syncReadyVersion()
        this.publish()
        // 只有待安装版本改变时才重建托盘菜单，不随下载进度重建。
        if (this.service.readyVersion() !== this.trayUpdateVersion) {
          this.trayUpdateVersion = this.service.readyVersion()
          deps.onReadyVersionChanged()
        }
      },
      log: this.log
    })

    this.restart = new UpdateRestart({
      readyVersion: () => this.service.readyVersion(),
      running: deps.running,
      isQuitting: deps.isQuitting,
      showMain: deps.showMain,
      publish: () => this.publish(),
      install: (v) => this.install(v)
    })

    registerUpdateIpc(ipcMain, deps.mainContents, {
      state: () => this.snapshot(),
      check: () => this.service.check('manual'),
      setAutoCheck: (enabled) => this.service.setAutoCheck(enabled),
      restart: async () => { this.restart.request('main') },
      openExternal: (url) => shell.openExternal(url).catch(() => { throw new Error('无法打开浏览器，请稍后再试。') })
    })
    registerUpdateConfirmationIpc(ipcMain, deps.mainContents, (id, accept) => this.restart.respond(id, accept))
  }

  snapshot(): UpdateSnapshot {
    return { ...this.service.snapshot(), confirmation: this.restart.confirmation() }
  }

  hasInstalledVersion(): boolean {
    return Boolean(this.service.snapshot().installedVersion)
  }

  readyVersion(): string | null {
    return this.service.readyVersion()
  }

  start(): void {
    this.service.start()
  }

  invalidateConfirmation(): void {
    this.restart.invalidate()
  }

  requestTrayRestart(): void {
    try { this.restart.request('tray') } catch { this.log('tray restart failed') }
  }

  saveBeforeExit(version: string | null = this.service.readyVersion()): void {
    if (this.exitSaved) return
    this.exitSaved = true
    prepareUpdateExit(
      version,
      () => this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'),
      (next) => snapshotBeforeUpdate(this.db, app.getPath('userData'), next),
      this.log
    )
  }

  dispose(): void {
    this.service.dispose()
  }

  private publish(): void {
    const contents = this.deps.mainContents()
    if (this.deps.isQuitting() || !contents || contents.isDestroyed()) return
    try { contents.send(UPDATE_IPC.changed, this.snapshot()) }
    catch { this.log('status delivery failed') }
  }

  private install(version: string): void {
    if (this.deps.isQuitting()) return
    try {
      try { this.prefs.expectRestart(version) } catch { this.log('could not save update restart marker') }
      // 更新库先启动安装器，再触发 before-quit；因此必须在调用它之前保存。
      this.saveBeforeExit(version)
      this.deps.setQuitting(true)
      this.service.installNow()
    } catch {
      this.deps.setQuitting(false)
      this.exitSaved = false
      try { this.prefs.expectRestart(null) } catch { this.log('could not clear update restart marker') }
      this.log('could not start explicit update')
      throw new Error('无法启动更新安装程序，请稍后再试。')
    }
  }
}
