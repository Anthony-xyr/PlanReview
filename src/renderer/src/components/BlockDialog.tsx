import { useState } from 'react'
import type { Category, Task } from '@shared/types'
import { Dialog, type Mutate } from '../ui'
import { hhmm } from '@shared/time'

export interface BlockDraft {
  kind: 'plan' | 'entry'
  /** 有 id 表示编辑已有条目 */
  id?: string
  taskId?: string | null
  title?: string
  categoryId?: string | null
  startAt: string
  /** null：正在计时 */
  endAt: string | null
}

interface Props {
  draft: BlockDraft
  tasks: Task[]
  categories: Category[]
  mutate: Mutate
  onClose: () => void
}

/** 'HH:MM' 换到与原时刻同一个日期上；结束早于开始时视为跨过零点 */
function withClock(base: string, clock: string): Date {
  const d = new Date(base)
  const [h, m] = clock.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d
}

export function BlockDialog({ draft, tasks, categories, mutate, onClose }: Props) {
  const isPlan = draft.kind === 'plan'
  const live = draft.endAt === null
  // 已删除任务的条目，taskId 为空，按自由名称处理
  const [mode, setMode] = useState<'task' | 'free'>(draft.taskId || (!draft.id && tasks.length) ? 'task' : 'free')
  const [taskId, setTaskId] = useState(draft.taskId ?? tasks[0]?.id ?? '')
  const [title, setTitle] = useState(draft.taskId ? '' : (draft.title ?? ''))
  const [categoryId, setCategoryId] = useState(draft.categoryId ?? '')
  const [start, setStart] = useState(hhmm(draft.startAt))
  const [end, setEnd] = useState(draft.endAt ? hhmm(draft.endAt) : '')

  // 编辑时任务列表里可能没有这个任务（已完成），补上
  const taskOptions = draft.taskId && !tasks.some((t) => t.id === draft.taskId) ? [{ id: draft.taskId, title: draft.title ?? '' }, ...tasks] : tasks

  const save = async () => {
    const s = withClock(draft.startAt, start)
    let e = live ? null : withClock(draft.endAt!, end)
    if (e && e <= s) e = new Date(e.getTime() + 86_400_000)
    if (e && e.getTime() - s.getTime() > 86_400_000) e = new Date(e.getTime() - 86_400_000)
    const subject = mode === 'task' ? { taskId, title: undefined, categoryId: undefined } : { taskId: null, title, categoryId: categoryId || null }
    const times = { startAt: s.toISOString(), ...(e ? { endAt: e.toISOString() } : {}) }
    const api = isPlan ? window.api.plan : window.api.entries
    const ok = await mutate(() =>
      draft.id
        ? (api.update as (id: string, p: object) => Promise<unknown>)(draft.id, { ...subject, ...times })
        : (api.create as (p: object) => Promise<unknown>)({ ...subject, ...times, endAt: e!.toISOString() })
    )
    if (ok) onClose()
  }

  const remove = async () => {
    const api = isPlan ? window.api.plan : window.api.entries
    await mutate(() => api.remove(draft.id!))
    onClose()
  }

  const heading = `${draft.id ? '编辑' : '新建'}${isPlan ? '计划' : '实际记录'}`

  return (
    <Dialog title={heading} onClose={onClose}>
      {!isPlan && !draft.id && <p className="dialog-lead">补录一段已经做过的事，和计时产生的记录同等对待。</p>}
      {isPlan && !draft.id && <p className="dialog-lead">计划只是安排，之后实际做了多久另外记录，原计划不会被改掉。</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="类型">
          <button type="button" role="radio" aria-checked={mode === 'task'} className={mode === 'task' ? 'on' : ''} onClick={() => setMode('task')} disabled={!taskOptions.length}>
            关联任务
          </button>
          <button type="button" role="radio" aria-checked={mode === 'free'} className={mode === 'free' ? 'on' : ''} onClick={() => setMode('free')}>
            {isPlan ? '保留时段' : '其他活动'}
          </button>
        </div>

        {mode === 'task' ? (
          <label className="field">
            <span>任务</span>
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)} required>
              {taskOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field-row">
            <label className="field">
              <span>名称</span>
              <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isPlan ? '如：打游戏、看番、吃饭' : '如：午饭、看番'} />
            </label>
            <label className="field">
              <span>大类</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">未分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="field-row">
          <label className="field">
            <span>开始</span>
            <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>结束</span>
            {live ? <input disabled value="计时中" /> : <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />}
          </label>
        </div>

        <div className="dialog-actions">
          {draft.id && (
            <button type="button" className="danger-btn" onClick={remove} disabled={live}>
              删除
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit">保存</button>
        </div>
      </form>
    </Dialog>
  )
}
