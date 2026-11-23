import type { DatabaseSync } from 'node:sqlite'

export function blockEndKey(blockId: string, endAt: string): string {
  return `block-end:${blockId}:${endAt}`
}

export function blockEndDue(end: Date, now: Date): boolean {
  const since = now.getTime() - end.getTime()
  return since >= 0 && since < 30 * 60_000
}

export function rememberDismissal(db: DatabaseSync, scope: 'once' | 'group', value: string, now: Date): void {
  db.prepare('INSERT OR IGNORE INTO reminder_dismissals (scope, value, created_at) VALUES (?, ?, ?)')
    .run(scope, value, now.toISOString())
}
