import type { DatabaseSync } from 'node:sqlite'
import { isNewerStable, stableVersion } from './version'

export interface CheckPreferences {
  enabled(): boolean
  setEnabled(enabled: boolean): void
  lastCheckedAt(): string | null
  recordCheck(at: string): void
}

/** 与应用其他设置共用 SQLite 键值表，不需要修改数据库结构。 */
export class UpdatePreferences implements CheckPreferences {
  constructor(private readonly db: DatabaseSync) {}

  private get(key: string): string | boolean | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (typeof row?.value !== 'string') return null
    try {
      const value: unknown = JSON.parse(row.value)
      return typeof value === 'string' || typeof value === 'boolean' ? value : null
    } catch { return null }
  }

  private set(key: string, value: string | boolean | null): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  enabled(): boolean { return this.get('autoCheckUpdates') !== false }
  setEnabled(enabled: boolean): void { this.set('autoCheckUpdates', enabled) }
  lastCheckedAt(): string | null {
    const at = this.get('lastUpdateCheckAt')
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null
  }
  recordCheck(at: string): void { this.set('lastUpdateCheckAt', at) }

  expectRestart(version: string | null): void { this.set('updateRestartTarget', version) }

  /** 只在用户选了立即重启，而且本次确实运行了目标版本时提示一次。 */
  recordStartup(current: string): string | null {
    const previous = this.get('lastRunVersion')
    const expected = this.get('updateRestartTarget')
    // 一条原子写入同时消费标记、记录本次版本，防止下次启动重复提示。
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('lastRunVersion', ?), ('updateRestartTarget', 'null')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(current))
    return typeof previous === 'string' && typeof expected === 'string' &&
      stableVersion(current) === expected && isNewerStable(current, previous) ? expected : null
  }
}
