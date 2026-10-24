import { useEffect, useMemo, useState } from 'react'
import type { Category, StartTimerInput, Task, TaskFilter, TaskInput, TimeEntry } from '@shared/types'
import type { Mutate } from '../ui'
import { formatMinutes, parseMinutes } from '@shared/format'
import { CategorySelect, TaskDetail } from './TaskDetail'
import { CaptureConfirm, useSmartCapture } from '../capture'
import { CategoryDialog, CategoryTabs } from './CategoryManager'

export type TaskViewKind =
  | { kind: 'inbox' }
  | { kind: 'active' }
  | { kind: 'done' }
  /** 类别页；id 为 null 时看未分类的 */
  | { kind: 'category'; id: string | null }
  | { kind: 'tag'; tag: string }

interface Props {
  view: TaskViewKind
  categories: Category[]
  version: number
  mutate: Mutate
  running: TimeEntry | null
  onStartTimer: (input: StartTimerInput) => void
  onNavigate: (v: TaskViewKind) => void
  /** 提示一句话并刷新各页面 */
  notify: (text: string, error?: boolean) => void
}

interface PageInfo {
  title: string
  intro: string
  empty: string
  filter: TaskFilter
  /** 在此页速记时带上的属性 */
  defaults: TaskInput
  placeholder: string
}

function pageInfo(view: TaskViewKind, categories: Category[]): PageInfo {
  switch (view.kind) {
    case 'inbox':
      return {
        title: '收件箱',
        intro: '随手记下的想法先放这里。整理时给它定个大类和估时，再移到待办，或者直接拖进「今天」的时间轴。',
        empty: '收件箱是空的。想到什么，在上面记一句就好，其余信息之后再补。',
        filter: { status: 'inbox' },
        defaults: {},
        placeholder: '记一句话，回车存进收件箱'
      }
    case 'active':
      return {
        title: '待办',
        intro: '整理过、准备去做的任务，按大类分组。数字是这一组的剩余估时（总估时减去已投入）。',
        empty: '还没有待办。可以在上面直接添加，或者去收件箱整理。',
        filter: { status: 'active' },
        defaults: { status: 'active' },
        placeholder: '添加待办，回车保存'
      }
    case 'done':
      return {
        title: '已结束',
        intro: '完成或放弃的任务，按结束日期排列。点开可以重新打开。',
        empty: '还没有结束的任务。',
        filter: { status: ['done', 'dropped'] },
        defaults: {},
        placeholder: ''
      }
    case 'category': {
      const c = view.id ? categories.find((x) => x.id === view.id) : undefined
      return {
        title: '类别',
        intro: '按类别查看还没结束的任务，点一项就能在右边修改。新任务请在收件箱或待办里记；AI 速记只会从现有类别里选。',
        empty: view.id ? `「${c?.name ?? ''}」下没有还没结束的任务。` : '没有未分类的任务。',
        filter: { categoryId: view.id, status: ['inbox', 'active'] },
        defaults: {},
        placeholder: ''
      }
    }
    case 'tag':
      return {
        title: `#${view.tag}`,
        intro: '带这个标签、还没结束的任务。在这里添加的任务会自动带上这个标签。',
        empty: '没有带这个标签的任务。',
        filter: { tag: view.tag, status: ['inbox', 'active'] },
        defaults: { tags: [view.tag], status: 'active' },
        placeholder: `添加带 #${view.tag} 的任务，回车保存`
      }
  }
}

const remaining = (t: Task) => (t.estimateMin == null ? 0 : Math.max(0, t.estimateMin - t.spentMin))

export function TasksView({ view, categories, version, mutate, running, onStartTimer, onNavigate, notify }: Props) {
  const info = pageInfo(view, categories)
  const [tasks, setTasks] = useState<Task[]>([])
  const [search, setSearch] = useState('')
  const [text, setText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [managing, setManaging] = useState<false | 'edit' | 'new'>(false)
  const active = categories.filter((c) => !c.archived)
  // 只在这一页才有的：类别页不新建任务
  const canCapture = view.kind !== 'done' && view.kind !== 'category'
  const viewKey = JSON.stringify(view)
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  useEffect(() => {
    setSelectedId(null)
    setSearch('')
  }, [viewKey])

  useEffect(() => {
    window.api.tasks.list({ ...info.filter, search: search || undefined }).then(setTasks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, search, version])

  const smart = useSmartCapture({
    defaults: info.defaults,
    onSaved: (_t, msg) => notify(msg),
    onError: (msg) => notify(msg, true)
  })

  const add = async () => {
    if (await smart.submit(text)) setText('')
  }

  const update = (id: string, patch: TaskInput) => mutate(() => window.api.tasks.update(id, patch))

  const row = (t: Task, opts: { triage?: boolean; showCat?: boolean } = {}) => (
    <TaskRow
      key={t.id}
      task={t}
      category={t.categoryId ? catById.get(t.categoryId) : undefined}
      categories={categories}
      selected={selectedId === t.id}
      running={running?.taskId === t.id}
      triage={opts.triage}
      showCat={opts.showCat ?? true}
      onSelect={() => setSelectedId(t.id)}
      onUpdate={(p) => update(t.id, p)}
      onStart={() => onStartTimer({ taskId: t.id })}
    />
  )

  const body = () => {
    if (!tasks.length) return <p className="empty">{search ? '没有匹配的任务。' : info.empty}</p>

    if (view.kind === 'inbox') return <ul className="task-list">{tasks.map((t) => row(t, { triage: true }))}</ul>

    if (view.kind === 'active') {
      const groups = new Map<string, Task[]>()
      for (const t of tasks) {
        const k = t.categoryId && catById.has(t.categoryId) ? t.categoryId : ''
        groups.set(k, [...(groups.get(k) ?? []), t])
      }
      const order = [...active, ...categories.filter((c) => c.archived)].map((c) => c.id).concat('').filter((k) => groups.has(k))
      return order.map((k) => {
        const list = groups.get(k)!
        const c = catById.get(k)
        const left = list.reduce((s, t) => s + remaining(t), 0)
        return (
          <section key={k || 'none'} className="group">
            <h3 className="group-head">
              {c && <span className="dot" style={{ background: c.color }} aria-hidden />}
              {c ? (
                <button className="link plain" onClick={() => onNavigate({ kind: 'category', id: c.id })}>
                  {c.name}
                </button>
              ) : (
                '未分类'
              )}
              <span className="muted">
                {list.length} 项{left ? ` · 剩余约 ${formatMinutes(left)}` : ''}
              </span>
            </h3>
            <ul className="task-list">{list.map((t) => row(t, { showCat: false }))}</ul>
          </section>
        )
      })
    }

    if (view.kind === 'done') {
      const groups = new Map<string, Task[]>()
      for (const t of [...tasks].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))) {
        const d = new Date(t.completedAt ?? t.updatedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
        groups.set(d, [...(groups.get(d) ?? []), t])
      }
      return [...groups].map(([d, list]) => (
        <section key={d} className="group">
          <h3 className="group-head">
            {d}
            <span className="muted">
              {list.length} 项 · 共投入 {formatMinutes(list.reduce((s, t) => s + t.spentMin, 0)) || '0m'}
            </span>
          </h3>
          <ul className="task-list">{list.map((t) => row(t))}</ul>
        </section>
      ))
    }

    if (view.kind === 'category') {
      // 先看准备做的，再看还没整理的
      const groups: [string, Task[]][] = [
        ['待办', tasks.filter((t) => t.status === 'active')],
        ['收件箱', tasks.filter((t) => t.status === 'inbox')]
      ]
      return groups
        .filter(([, list]) => list.length)
        .map(([label, list]) => {
          const left = list.reduce((s, t) => s + remaining(t), 0)
          return (
            <section key={label} className="group">
              <h3 className="group-head">
                {label}
                <span className="muted">
                  {list.length} 项{left ? ` · 剩余约 ${formatMinutes(left)}` : ''}
                </span>
              </h3>
              <ul className="task-list">{list.map((t) => row(t, { showCat: false }))}</ul>
            </section>
          )
        })
    }

    return <ul className="task-list">{tasks.map((t) => row(t))}</ul>
  }

  const totalLeft = tasks.reduce((s, t) => s + remaining(t), 0)
  const noEstimate = tasks.filter((t) => t.estimateMin == null).length

  return (
    <div className="tasks-page">
      <main className="main">
        <header className="page-head stacked">
          <div className="head-row">
            <h1>
              {info.title}
              <span className="sub">{tasks.length} 项</span>
            </h1>
            {view.kind === 'category' && (
              <button className="secondary" onClick={() => setManaging('edit')}>
                管理类别
              </button>
            )}
          </div>
          <p className="intro">{info.intro}</p>
          {view.kind !== 'done' && totalLeft > 0 && (
            <p className="summary">
              剩余估时约 <strong>{formatMinutes(totalLeft) || '0m'}</strong>
              {noEstimate > 0 && <span className="muted">（{noEstimate} 项还没估时）</span>}
            </p>
          )}
        </header>

        {view.kind === 'category' && (
          <CategoryTabs
            categories={categories}
            selected={view.id}
            version={version}
            onSelect={(id) => onNavigate({ kind: 'category', id })}
            onCreate={() => setManaging('new')}
          />
        )}

        {canCapture && (
          <form
            className="capture"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <input
              aria-label="添加任务"
              placeholder={smart.aiOn ? `${info.placeholder}（AI 会拆出日期、估时、大类）` : info.placeholder}
              value={text}
              disabled={smart.busy}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={!text.trim() || smart.busy}>
              {smart.busy ? '解析中…' : '添加'}
            </button>
          </form>
        )}

        {smart.pending && (
          <CaptureConfirm
            key={smart.pending.text}
            original={smart.pending.text}
            draft={smart.pending.draft}
            categories={categories}
            onConfirm={smart.confirm}
            onKeepRaw={smart.keepRaw}
            onCancel={() => {
              setText(smart.pending!.text)
              smart.cancel()
            }}
          />
        )}

        <input
          className="search"
          type="search"
          placeholder="在这一页里搜索标题、备注、下一步"
          aria-label="搜索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {body()}
      </main>

      {selectedId && (
        <TaskDetail
          key={selectedId}
          taskId={selectedId}
          categories={categories}
          onClose={() => setSelectedId(null)}
          onSelect={setSelectedId}
          mutate={mutate}
          version={version}
          running={running}
          onStartTimer={onStartTimer}
        />
      )}

      {managing && (
        <CategoryDialog
          categories={categories}
          version={version}
          mutate={mutate}
          focusNew={managing === 'new'}
          onClose={() => setManaging(false)}
          onRemoved={(id) => {
            // 正在看的类别被删掉了，换到剩下的第一个
            if (view.kind === 'category' && view.id === id) onNavigate({ kind: 'category', id: active.find((c) => c.id !== id)?.id ?? null })
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  task: Task
  category?: Category
  categories: Category[]
  selected: boolean
  running: boolean
  triage?: boolean
  showCat: boolean
  onSelect: () => void
  onUpdate: (p: TaskInput) => void
  onStart: () => void
}

function TaskRow({ task: t, category, categories, selected, running, triage, showCat, onSelect, onUpdate, onStart }: RowProps) {
  const done = t.status === 'done'
  const ended = done || t.status === 'dropped'
  const [est, setEst] = useState(formatMinutes(t.estimateMin))
  useEffect(() => setEst(formatMinutes(t.estimateMin)), [t.estimateMin])

  return (
    <li className={`task-row ${selected ? 'is-selected' : ''} ${ended ? 'is-done' : ''}`}>
      <input
        type="checkbox"
        checked={done}
        aria-label={done ? `重新打开「${t.title}」` : `完成「${t.title}」`}
        onChange={() => onUpdate({ status: done ? 'active' : 'done' })}
      />
      <button className="task-main" onClick={onSelect}>
        <span className="task-title">
          {t.status === 'dropped' && <span className="badge">已放弃</span>}
          {t.title}
        </span>
        <span className="task-meta">
          {showCat && category && (
            <span className="chip" style={{ borderColor: category.color, color: category.color }}>
              {category.name}
            </span>
          )}
          {t.tags.map((g) => (
            <span key={g} className="tag">
              #{g}
            </span>
          ))}
          {!triage && (t.estimateMin != null || t.spentMin > 0) && (
            <span>
              已投入 {formatMinutes(t.spentMin) || '0m'}
              {t.estimateMin != null && ` / 估 ${formatMinutes(t.estimateMin)}`}
            </span>
          )}
          {t.dueDate && <span>截止 {t.dueDate}</span>}
          {t.reviewDate && !ended && <span title="到这天会出现在「今天」页">{t.reviewDate} 再看</span>}
          {t.sourceTaskId && <span title="从其他任务延伸出来">↳ 延伸</span>}
          {t.nextStep && <span className="next">下一步：{t.nextStep}</span>}
        </span>
      </button>

      {triage && (
        <div className="triage">
          <CategorySelect aria-label="类别" emptyLabel="类别…" categories={categories} value={t.categoryId} onChange={(categoryId) => onUpdate({ categoryId })} />
          <input
            aria-label="估时"
            className="est"
            placeholder="估时"
            value={est}
            onChange={(e) => setEst(e.target.value)}
            onBlur={() => {
              const m = parseMinutes(est)
              if (m === undefined) setEst(formatMinutes(t.estimateMin))
              else if (m !== t.estimateMin) onUpdate({ estimateMin: m })
            }}
          />
          <button className="secondary" onClick={() => onUpdate({ status: 'active' })}>
            移到待办
          </button>
        </div>
      )}

      {!ended && (
        <button className="secondary icon start" onClick={onStart} disabled={running} aria-label={`开始计时「${t.title}」`} title="开始计时">
          {running ? '●' : '▶'}
        </button>
      )}
    </li>
  )
}
