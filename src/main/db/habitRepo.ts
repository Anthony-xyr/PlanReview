import type { DatabaseSync } from 'node:sqlite'
import type { CaptureHabit } from '@shared/types'
import { MAX_HABIT_CHARS, MAX_HABITS } from '@shared/types'

interface HabitRow {
  id: string
  text: string
  example: string
  enabled: number
  used_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

const toHabit = (r: HabitRow): CaptureHabit => ({
  id: r.id,
  text: r.text,
  example: r.example,
  enabled: r.enabled === 1,
  usedCount: r.used_count,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

function cleanText(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) throw new Error('习惯不能为空')
  if (t.length > MAX_HABIT_CHARS) throw new Error(`一条习惯最多 ${MAX_HABIT_CHARS} 个字`)
  return t
}

/** 速记习惯：只有用户确认的才会写进来，AI 解析速记时参考启用的那些 */
export class HabitRepo {
  /** now 可注入，方便测试 */
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date()
  ) {}

  list(): CaptureHabit[] {
    return (this.db.prepare('SELECT * FROM capture_habits ORDER BY created_at DESC, rowid DESC').all() as unknown as HabitRow[]).map(toHabit)
  }

  enabled(): CaptureHabit[] {
    return this.list().filter((h) => h.enabled)
  }

  get(id: string): CaptureHabit | null {
    const row = this.db.prepare('SELECT * FROM capture_habits WHERE id = ?').get(id) as HabitRow | undefined
    return row ? toHabit(row) : null
  }

  /**
   * 记下一条习惯。replacesId 给了就改写那一条（保留使用次数），否则新增。
   * 文字和已有的一样时不重复记，直接返回那一条并确保启用。
   */
  add(text: string, example = '', replacesId: string | null = null): CaptureHabit {
    const t = cleanText(text)
    const ex = example.trim().slice(0, 200)
    const iso = this.now().toISOString()
    if (replacesId && this.get(replacesId)) {
      this.db.prepare('UPDATE capture_habits SET text = ?, example = ?, enabled = 1, updated_at = ? WHERE id = ?').run(t, ex, iso, replacesId)
      return this.get(replacesId)!
    }
    const dup = this.list().find((h) => h.text === t)
    if (dup) return dup.enabled ? dup : this.update(dup.id, { enabled: true })
    if (this.list().length >= MAX_HABITS) throw new Error(`最多记 ${MAX_HABITS} 条习惯，先到设置里删掉一些不再需要的`)
    const id = crypto.randomUUID()
    this.db
      .prepare('INSERT INTO capture_habits (id, text, example, enabled, used_count, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)')
      .run(id, t, ex, iso, iso)
    return this.get(id)!
  }

  update(id: string, patch: { text?: string; enabled?: boolean }): CaptureHabit {
    const cur = this.get(id)
    if (!cur) throw new Error('这条习惯不存在')
    const text = patch.text === undefined ? cur.text : cleanText(patch.text)
    const enabled = patch.enabled ?? cur.enabled
    this.db.prepare('UPDATE capture_habits SET text = ?, enabled = ?, updated_at = ? WHERE id = ?').run(text, enabled ? 1 : 0, this.now().toISOString(), id)
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM capture_habits WHERE id = ?').run(id)
  }

  /** 用户确认保存了一次速记，把这次 AI 说用到的习惯记一次使用 */
  markUsed(ids: string[]): void {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const stmt = this.db.prepare('UPDATE capture_habits SET used_count = used_count + 1, last_used_at = ? WHERE id = ?')
    const iso = this.now().toISOString()
    for (const id of unique) stmt.run(iso, id)
  }
}
