import { useEffect, useState } from 'react'
import type { Category, StartTimerInput, Task, TaskInput, TaskStatus, TimeEntry } from '@shared/types'
import type { Mutate } from '../ui'
import { formatMinutes, parseMinutes, todayLocal } from '@shared/format'

interface Props {
  taskId: string
  categories: Category[]
  onClose: () => void
  onSelect: (id: string) => void
  mutate: Mutate
  version: number
  running: TimeEntry | null
  onStartTimer: (input: StartTimerInput) => void
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: '收件箱',
  active: '待办',
  done: '已完成',
  dropped: '已放弃'
}

export function TaskDetail({ taskId, categories, onClose, onSelect, mutate, version, running, onStartTimer }: Props) {
  const [task, setTask] = useState<Task | null>(null)
  const [lineage, setLineage] = useState<Task[]>([])
  const [estimate, setEstimate] = useState('')
  const [estimateError, setEstimateError] = useState(false)
  const [tagsText, setTagsText] = useState('')
  const [spinOffTitle, setSpinOffTitle] = useState('')

  const load = async () => {
    const [t, l] = await Promise.all([window.api.tasks.get(taskId), window.api.tasks.lineage(taskId)])
    setTask(t)
    setLineage(l)
    if (t) {
      setEstimate(formatMinutes(t.estimateMin))
      setTagsText(t.tags.join(' '))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, version])

  if (!task) return <aside className="detail" aria-label="任务详情" />

  const save = (patch: TaskInput) => mutate(() => window.api.tasks.update(task.id, patch))

  const saveEstimate = () => {
    const parsed = parseMinutes(estimate)
    if (parsed === undefined) return setEstimateError(true)
    setEstimateError(false)
    if (parsed !== task.estimateMin) save({ estimateMin: parsed })
  }

  const saveTags = () => {
    const next = tagsText.split(/[\s,，]+/).filter(Boolean)
    if (next.join(' ') !== task.tags.join(' ')) save({ tags: next })
  }

  const spinOff = () => {
    const title = spinOffTitle.trim()
    if (!title) return
    mutate(() => window.api.tasks.spinOff(task.id, { title })).then((t) => t && setSpinOffTitle(''))
  }

  return (
    <aside className="detail" aria-label="任务详情">
      <div className="detail-head">
        <span className="badge">{STATUS_LABEL[task.status]}</span>
        <button className="link" onClick={onClose} aria-label="关闭详情">
          关闭
        </button>
      </div>

      <div className="spent">
        <div>
          已投入 <strong>{formatMinutes(task.spentMin) || '0m'}</strong>
          {task.estimateMin != null && <> / 总估时 {formatMinutes(task.estimateMin)}</>}
        </div>
        {task.status !== 'done' && task.status !== 'dropped' && (
          <button onClick={() => onStartTimer({ taskId: task.id })} disabled={running?.taskId === task.id}>
            {running?.taskId === task.id ? '计时中' : '▶ 开始计时'}
          </button>
        )}
      </div>

      <label className="field">
        <span>标题</span>
        <input
          defaultValue={task.title}
          onBlur={(e) => e.target.value.trim() !== task.title && save({ title: e.target.value })}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>类别</span>
          <CategorySelect categories={categories} value={task.categoryId} onChange={(categoryId) => save({ categoryId })} />
        </label>
        <label className="field">
          <span>总估时</span>
          <input
            placeholder="如 3h、90、1h30m"
            value={estimate}
            aria-invalid={estimateError}
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={saveEstimate}
          />
          {estimateError && <small className="hint-error">格式不对，试试 2h 或 90</small>}
        </label>
      </div>

      <label className="field">
        <span>标签（空格分隔）</span>
        <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} onBlur={saveTags} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>截止日期</span>
          <input type="date" value={task.dueDate ?? ''} onChange={(e) => save({ dueDate: e.target.value || null })} />
        </label>
        <label className="field">
          <span>下次查看日</span>
          <input
            type="date"
            min={todayLocal()}
            value={task.reviewDate ?? ''}
            onChange={(e) => save({ reviewDate: e.target.value || null })}
          />
        </label>
      </div>

      <label className="field">
        <span>下一步</span>
        <input
          placeholder="下次打开时先做什么"
          defaultValue={task.nextStep}
          onBlur={(e) => e.target.value !== task.nextStep && save({ nextStep: e.target.value })}
        />
      </label>

      <label className="field">
        <span>备注</span>
        <textarea
          rows={4}
          defaultValue={task.notes}
          onBlur={(e) => e.target.value !== task.notes && save({ notes: e.target.value })}
        />
      </label>

      <div className="actions">
        {task.status === 'inbox' && (
          <button className="secondary" onClick={() => save({ status: 'active' })}>
            移到待办
          </button>
        )}
        {task.status !== 'done' && <button onClick={() => save({ status: 'done' })}>完成</button>}
        {task.status !== 'dropped' && task.status !== 'done' && (
          <button className="secondary" onClick={() => save({ status: 'dropped' })}>
            放弃
          </button>
        )}
        {(task.status === 'done' || task.status === 'dropped') && (
          <button onClick={() => save({ status: 'active' })}>重新打开</button>
        )}
      </div>

      <section className="lineage" aria-label="延伸">
        <h3>延伸</h3>
        <p className="muted">范围变大时，把多出来的部分拆成新任务，可以排到别的日子。</p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            spinOff()
          }}
        >
          <input
            placeholder="延伸出的新任务"
            aria-label="延伸任务标题"
            value={spinOffTitle}
            onChange={(e) => setSpinOffTitle(e.target.value)}
          />
          <button type="submit" className="secondary" disabled={!spinOffTitle.trim()}>
            拆出
          </button>
        </form>
        {lineage.length > 1 && (
          <ul className="lineage-list">
            {lineage.map((t) => (
              <li key={t.id}>
                <button
                  className={`link ${t.id === task.id ? 'is-current' : ''}`}
                  style={{ paddingLeft: depthOf(t, lineage) * 14 }}
                  onClick={() => onSelect(t.id)}
                >
                  {t.status === 'done' ? '✓ ' : ''}
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        className="danger"
        onClick={() => {
          if (confirm(`删除「${task.title}」？这一步不能撤销。`)) {
            mutate(() => window.api.tasks.remove(task.id)).then(onClose)
          }
        }}
      >
        删除任务
      </button>
    </aside>
  )
}

/**
 * 类别选择框：只列现有类别。任务当前的类别已被删除时，把它作为当前值留在列表里，
 * 这样打开旧任务不会被悄悄改成未分类。
 */
export function CategorySelect({
  categories,
  value,
  onChange,
  emptyLabel = '未分类',
  ...rest
}: {
  categories: Category[]
  value: string | null
  onChange: (id: string | null) => void
  emptyLabel?: string
  'aria-label'?: string
}) {
  const current = value ? categories.find((c) => c.id === value) : undefined
  return (
    <select {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{emptyLabel}</option>
      {categories
        .filter((c) => !c.archived)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      {current?.archived && <option value={current.id}>{current.name}（已删除）</option>}
    </select>
  )
}

function depthOf(task: Task, all: Task[]): number {
  const byId = new Map(all.map((t) => [t.id, t]))
  let depth = 0
  let cur = task
  while (cur.sourceTaskId && byId.has(cur.sourceTaskId)) {
    cur = byId.get(cur.sourceTaskId)!
    depth++
  }
  return depth
}
