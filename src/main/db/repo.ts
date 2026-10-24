import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Category, Task, TaskFilter, TaskInput } from '@shared/types'

interface TaskRow {
  id: string
  title: string
  notes: string
  status: Task['status']
  category_id: string | null
  estimate_min: number | null
  next_step: string
  source_task_id: string | null
  due_date: string | null
  review_date: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  tags: string | null
  spent_min: number
}

interface CategoryRow {
  id: string
  name: string
  color: string
  sort: number
  archived: number
}

const TAG_SEP = '\u001f'

// 标签用不可见分隔符聚合，避免与标签内容冲突
const TASK_SELECT = `
  SELECT t.*,
    (SELECT group_concat(tag, '${TAG_SEP}') FROM task_tags WHERE task_id = t.id) AS tags,
    (SELECT COALESCE(SUM(julianday(COALESCE(end_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(start_at)), 0) * 1440
       FROM time_entries WHERE task_id = t.id) AS spent_min
  FROM tasks t`

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    status: r.status,
    categoryId: r.category_id,
    tags: r.tags ? r.tags.split(TAG_SEP).sort() : [],
    estimateMin: r.estimate_min,
    nextStep: r.next_step,
    sourceTaskId: r.source_task_id,
    dueDate: r.due_date,
    reviewDate: r.review_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    spentMin: Math.round(r.spent_min)
  }
}

function toCategory(r: CategoryRow): Category {
  return { id: r.id, name: r.name, color: r.color, sort: r.sort, archived: r.archived === 1 }
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
}

// 界面字段名 → 列名
const COLUMNS: Record<Exclude<keyof TaskInput, 'tags'>, string> = {
  title: 'title',
  notes: 'notes',
  status: 'status',
  categoryId: 'category_id',
  estimateMin: 'estimate_min',
  nextStep: 'next_step',
  sourceTaskId: 'source_task_id',
  dueDate: 'due_date',
  reviewDate: 'review_date'
}

export class Repo {
  constructor(private db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---------- 任务 ----------

  getTask(id: string): Task | null {
    const row = this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const where: string[] = []
    const params: SQLInputValue[] = []

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      where.push(`t.status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }
    if (filter.categoryId === null) where.push('t.category_id IS NULL')
    else if (filter.categoryId) {
      where.push('t.category_id = ?')
      params.push(filter.categoryId)
    }
    if (filter.tag) {
      where.push('EXISTS (SELECT 1 FROM task_tags WHERE task_id = t.id AND tag = ?)')
      params.push(filter.tag)
    }
    if (filter.search?.trim()) {
      const like = `%${filter.search.trim().replace(/[\\%_]/g, '\\$&')}%`
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR t.next_step LIKE ? ESCAPE '\\')`)
      params.push(like, like, like)
    }

    const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC`
    return (this.db.prepare(sql).all(...params) as unknown as TaskRow[]).map(toTask)
  }

  /** 快速收集：只需要一句话，其余字段后补 */
  capture(text: string, defaults: TaskInput = {}): Task {
    const title = text.trim()
    if (!title) throw new Error('内容不能为空')
    return this.createTask({ status: 'inbox', ...defaults, title })
  }

  createTask(input: TaskInput): Task {
    const title = input.title?.trim()
    if (!title) throw new Error('标题不能为空')
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, notes, status, category_id, estimate_min, next_step,
             source_task_id, due_date, review_date, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          title,
          input.notes ?? '',
          input.status ?? 'inbox',
          input.categoryId ?? null,
          input.estimateMin ?? null,
          input.nextStep ?? '',
          input.sourceTaskId ?? null,
          input.dueDate ?? null,
          input.reviewDate ?? null,
          now,
          now,
          input.status === 'done' ? now : null
        )
      this.setTags(id, input.tags ?? [])
    })
    return this.getTask(id)!
  }

  updateTask(id: string, patch: TaskInput): Task {
    const existing = this.getTask(id)
    if (!existing) throw new Error('任务不存在')
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('标题不能为空')
    if (patch.sourceTaskId && this.wouldCycle(id, patch.sourceTaskId)) throw new Error('来源不能形成循环')

    const sets: string[] = []
    const params: SQLInputValue[] = []
    for (const [key, col] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
      if (patch[key] === undefined) continue
      sets.push(`${col} = ?`)
      const value = patch[key]
      params.push(key === 'title' ? (value as string).trim() : (value as SQLInputValue))
    }

    // 完成时间随状态变化
    if (patch.status !== undefined && patch.status !== existing.status) {
      sets.push('completed_at = ?')
      params.push(patch.status === 'done' ? new Date().toISOString() : null)
    }

    this.tx(() => {
      sets.push('updated_at = ?')
      params.push(new Date().toISOString())
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      if (patch.tags !== undefined) this.setTags(id, patch.tags)
    })
    return this.getTask(id)!
  }

  /** 删除任务时，把标题和大类写回计划与记录，保留历史 */
  deleteTask(id: string): void {
    const task = this.getTask(id)
    if (!task) return
    this.tx(() => {
      for (const table of ['plan_blocks', 'time_entries'])
        this.db.prepare(`UPDATE ${table} SET title = ?, category_id = ? WHERE task_id = ?`).run(task.title, task.categoryId, id)
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    })
  }

  spinOff(sourceId: string, input: TaskInput): Task {
    const source = this.getTask(sourceId)
    if (!source) throw new Error('来源任务不存在')
    return this.createTask({
      categoryId: source.categoryId,
      tags: source.tags,
      status: 'active',
      ...input,
      sourceTaskId: sourceId
    })
  }

  /** 来源链：沿 source 向上找到根，再取根的全部后代（含根） */
  lineage(id: string): Task[] {
    const rootRow = this.db
      .prepare(
        `WITH RECURSIVE up(id, source_task_id, depth) AS (
           SELECT id, source_task_id, 0 FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.source_task_id, up.depth + 1 FROM tasks t JOIN up ON t.id = up.source_task_id
         )
         SELECT id FROM up ORDER BY depth DESC LIMIT 1`
      )
      .get(id) as { id: string } | undefined
    if (!rootRow) return []

    const ids = this.db
      .prepare(
        `WITH RECURSIVE down(id) AS (
           SELECT ?
           UNION
           SELECT t.id FROM tasks t JOIN down ON t.source_task_id = down.id
         )
         SELECT id FROM down`
      )
      .all(rootRow.id) as { id: string }[]

    return ids.map((r) => this.getTask(r.id)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private wouldCycle(id: string, newSourceId: string): boolean {
    if (id === newSourceId) return true
    const row = this.db
      .prepare(
        `WITH RECURSIVE up(id, source_task_id) AS (
           SELECT id, source_task_id FROM tasks WHERE id = ?
           UNION
           SELECT t.id, t.source_task_id FROM tasks t JOIN up ON t.id = up.source_task_id
         )
         SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`
      )
      .get(newSourceId, id)
    return row !== undefined
  }

  private setTags(taskId: string, tags: string[]): void {
    this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    const insert = this.db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)')
    for (const tag of normalizeTags(tags)) insert.run(taskId, tag)
  }

  listTags(): string[] {
    return (this.db.prepare('SELECT DISTINCT tag FROM task_tags ORDER BY tag').all() as { tag: string }[]).map(
      (r) => r.tag
    )
  }

  // ---------- 大类 ----------

  listCategories(): Category[] {
    return (this.db.prepare('SELECT * FROM categories ORDER BY sort, name').all() as unknown as CategoryRow[]).map(
      toCategory
    )
  }

  createCategory(name: string, color: string): Category {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('名称不能为空')
    if (trimmed.length > 20) throw new Error('名称最多 20 个字')
    this.assertUniqueName(trimmed)
    const id = crypto.randomUUID()
    const { next } = this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM categories').get() as {
      next: number
    }
    this.db
      .prepare('INSERT INTO categories (id, name, color, sort, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, trimmed, color, next, new Date().toISOString())
    return this.getCategory(id)!
  }

  updateCategory(id: string, patch: Partial<Pick<Category, 'name' | 'color' | 'sort' | 'archived'>>): Category {
    const cur = this.getCategory(id)
    if (!cur) throw new Error('类别不存在')
    const archived = patch.archived ?? cur.archived
    if (!archived && (patch.name !== undefined || patch.archived === false)) this.assertUniqueName(patch.name?.trim() || cur.name, id)
    const sets: string[] = []
    const params: SQLInputValue[] = []
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('名称不能为空')
      if (patch.name.trim().length > 20) throw new Error('名称最多 20 个字')
      sets.push('name = ?')
      params.push(patch.name.trim())
    }
    if (patch.color !== undefined) sets.push('color = ?'), params.push(patch.color)
    if (patch.sort !== undefined) sets.push('sort = ?'), params.push(patch.sort)
    if (patch.archived !== undefined) sets.push('archived = ?'), params.push(patch.archived ? 1 : 0)
    sets.push('updated_at = ?')
    params.push(new Date().toISOString())
    this.db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    return this.getCategory(id)!
  }

  /**
   * 删除类别：只归档不删行，已有任务、计划、记录继续显示它，之后不能再选。
   * moveOpenTo 给了类别 id 就把还没结束的任务改过去，给 null 改成未分类，不给则保留原类别。
   */
  removeCategory(id: string, moveOpenTo?: string | null): Category {
    if (!this.getCategory(id)) throw new Error('类别不存在')
    if (moveOpenTo) {
      const to = this.getCategory(moveOpenTo)
      if (!to || to.archived || to.id === id) throw new Error('要改到的类别不存在')
    }
    const now = new Date().toISOString()
    return this.tx(() => {
      if (moveOpenTo !== undefined)
        this.db
          .prepare("UPDATE tasks SET category_id = ?, updated_at = ? WHERE category_id = ? AND status IN ('inbox', 'active')")
          .run(moveOpenTo, now, id)
      this.db.prepare('UPDATE categories SET archived = 1, updated_at = ? WHERE id = ?').run(now, id)
      return this.getCategory(id)!
    })
  }

  /** 按 ids 的顺序重排；没列出的（如已删除的）排在后面，保持原有先后 */
  reorderCategories(ids: string[]): void {
    const all = this.listCategories()
    const known = new Set(all.map((c) => c.id))
    if (ids.some((id) => !known.has(id))) throw new Error('类别不存在')
    const order = [...ids, ...all.map((c) => c.id).filter((id) => !ids.includes(id))]
    const now = new Date().toISOString()
    const update = this.db.prepare('UPDATE categories SET sort = ?, updated_at = ? WHERE id = ?')
    this.tx(() => order.forEach((id, i) => update.run(i, now, id)))
  }

  /** 每个类别还没结束的任务数；未分类的键为 '' */
  openCountByCategory(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT COALESCE(category_id, '') AS id, COUNT(*) AS n FROM tasks WHERE status IN ('inbox', 'active') GROUP BY category_id")
      .all() as { id: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.id, r.n]))
  }

  /** 没删除的类别里不能重名，否则 AI 按名称匹配时分不清 */
  private assertUniqueName(name: string, exceptId = ''): void {
    const dup = this.db.prepare('SELECT 1 FROM categories WHERE archived = 0 AND lower(name) = lower(?) AND id != ?').get(name, exceptId)
    if (dup) throw new Error(`已经有叫「${name}」的类别了`)
  }

  private getCategory(id: string): Category | null {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined
    return row ? toCategory(row) : null
  }
}
