import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const SNAPSHOT = /^before-update-[0-9A-Za-z._+-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[\da-f]{8}\.db$/

export function snapshotBeforeUpdate(db: DatabaseSync, userData: string, version: string, now: Date = new Date()): string {
  const directory = join(userData, 'backups')
  mkdirSync(directory, { recursive: true })
  const safeVersion = version.replace(/[^0-9A-Za-z._+-]/g, '_').slice(0, 64) || 'unknown'
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const file = join(directory, `before-update-${safeVersion}-${stamp}-${randomUUID().slice(0, 8)}.db`)
  const partial = `${file}.partial`
  try {
    // SQLite 从同一读事务生成快照，包含 WAL 中已提交、尚未回写到主文件的记录。
    db.prepare('VACUUM INTO ?').run(partial)
    renameSync(partial, file)
  } catch (error) {
    try { unlinkSync(partial) } catch { /* 尚未写出或已移走 */ }
    throw error
  }
  const backups = readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && SNAPSHOT.test(item.name))
    .map((item) => ({ path: join(directory, item.name), time: statSync(join(directory, item.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || b.path.localeCompare(a.path))
  for (const old of backups.filter((item) => item.path !== file).slice(2)) unlinkSync(old.path)
  return file
}
