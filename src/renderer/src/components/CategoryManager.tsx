import { useEffect, useRef, useState } from 'react'
import type { Category } from '@shared/types'
import { Dialog, errorText, type Mutate } from '../ui'

/** 与主进程的默认色板一致：相邻两色在各类色觉下都能分清 */
const PALETTE: { color: string; name: string }[] = [
  { color: '#2a78d6', name: '蓝' },
  { color: '#eb6834', name: '橙' },
  { color: '#1baf7a', name: '绿' },
  { color: '#eda100', name: '黄' },
  { color: '#e87ba4', name: '粉' },
  { color: '#4a3aa7', name: '紫' },
  { color: '#008300', name: '深绿' },
  { color: '#e34948', name: '红' }
]

/** 各类别没结束的任务数，随数据刷新 */
function useOpenCounts(version: number): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    window.api.categories.openCounts().then(setCounts)
  }, [version])
  return counts
}

// ---------- 类别切换条 ----------

interface TabsProps {
  categories: Category[]
  /** null 为未分类 */
  selected: string | null
  version: number
  onSelect: (id: string | null) => void
  onCreate: () => void
}

/**
 * 类别页顶部的切换条。现有类别按顺序排；未分类、已删除但还有没结束任务的类别排在后面，
 * 这样任何一个没结束的任务都能在这里找到。
 */
export function CategoryTabs({ categories, selected, version, onSelect, onCreate }: TabsProps) {
  const counts = useOpenCounts(version)
  const n = (id: string | null) => counts[id ?? ''] ?? 0
  const active = categories.filter((c) => !c.archived)
  const deleted = categories.filter((c) => c.archived && (n(c.id) > 0 || c.id === selected))

  const tab = (id: string | null, label: string, color: string | null, isDeleted = false) => (
    <button
      key={id ?? 'none'}
      className={`cat-tab ${selected === id ? 'is-on' : ''} ${isDeleted ? 'is-deleted' : ''}`}
      aria-pressed={selected === id}
      title={isDeleted ? '这个类别已删除，下面是还留着它的任务' : undefined}
      onClick={() => onSelect(id)}
    >
      <span className={`dot ${color ? '' : 'is-empty'}`} style={color ? { background: color } : undefined} aria-hidden />
      <span>{label}</span>
      <span className="cat-tab-n" aria-label={`${n(id)} 项`}>{n(id)}</span>
    </button>
  )

  return (
    <div className="cat-tabs" role="group" aria-label="选择类别">
      {active.map((c) => tab(c.id, c.name, c.color))}
      {(n(null) > 0 || selected === null) && tab(null, '未分类', null)}
      {deleted.map((c) => tab(c.id, `${c.name}（已删除）`, c.color, true))}
      <button className="cat-tab is-add" onClick={onCreate}>
        + 新建类别
      </button>
    </div>
  )
}

// ---------- 管理类别 ----------

interface DialogProps {
  categories: Category[]
  version: number
  mutate: Mutate
  /** 从「+ 新建类别」打开时，直接把光标放进新建框 */
  focusNew?: boolean
  onClose: () => void
  /** 删除了某个类别；页面正在看它时切到别的类别 */
  onRemoved: (id: string) => void
}

/**
 * 管理类别：改名、换色、调整顺序、新建、删除、恢复，改动立即保存。
 * 对话框盖住了页面底部的提示条，出错时在框内显示。
 */
export function CategoryDialog({ categories, version, mutate, focusNew, onClose, onRemoved }: DialogProps) {
  const counts = useOpenCounts(version)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string | null>(null)
  const newRef = useRef<HTMLInputElement>(null)
  // showModal 会把焦点放到第一个按钮上，之后再移到新建框
  useEffect(() => {
    if (focusNew) setTimeout(() => newRef.current?.focus(), 0)
  }, [focusNew])
  const active = categories.filter((c) => !c.archived)
  const archived = categories.filter((c) => c.archived)

  // 新类别默认取色板里还没人用的第一个颜色
  const used = new Set(active.map((c) => c.color.toLowerCase()))
  const color = newColor ?? PALETTE.find((p) => !used.has(p.color))?.color ?? PALETTE[active.length % PALETTE.length].color

  /** 执行修改：成功后刷新各页面，失败时在框内提示并返回 undefined */
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null)
    try {
      const r = await fn()
      await mutate(async () => r)
      return r
    } catch (e) {
      setError(errorText(e))
      return undefined
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const ids = active.map((c) => c.id)
    ;[ids[i], ids[i + d]] = [ids[i + d], ids[i]]
    run(() => window.api.categories.reorder(ids))
  }

  const add = async () => {
    const name = newName.trim()
    if (!name) return
    if (await run(() => window.api.categories.create(name, color))) {
      setNewName('')
      setNewColor(null)
    }
  }

  return (
    <Dialog title="管理类别" onClose={onClose}>
      <div className="cat-manage">
        <p className="dialog-lead">改动立即保存。这里的顺序也是各处选择框和 AI 速记里的顺序。</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <ul className="cat-rows" aria-label="现有类别">
          {active.map((c, i) => (
            <CategoryRow
              key={c.id}
              category={c}
              open={counts[c.id] ?? 0}
              first={i === 0}
              last={i === active.length - 1}
              others={active.filter((x) => x.id !== c.id)}
              removing={removing === c.id}
              run={run}
              onMove={(d) => move(i, d)}
              onAskRemove={() => setRemoving(c.id)}
              onCancelRemove={() => setRemoving(null)}
              onRemoved={() => {
                setRemoving(null)
                onRemoved(c.id)
              }}
            />
          ))}
        </ul>
        {active.length === 0 && <p className="muted">还没有类别。在下面新建一个。</p>}

        <form
          className="cat-new"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <ColorPicker value={color} label="新类别" onChange={setNewColor} />
          <input
            ref={newRef}
            aria-label="新类别名称"
            placeholder="新类别名称，如：社团、实习"
            maxLength={20}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!newName.trim()}>
            添加
          </button>
        </form>

        {archived.length > 0 && (
          <details className="cat-archived">
            <summary>已删除的类别（{archived.length}）</summary>
            <p className="muted">恢复后会重新出现在选择框和 AI 速记里。</p>
            <ul>
              {archived.map((c) => (
                <li key={c.id}>
                  <span className="dot" style={{ background: c.color }} aria-hidden />
                  <span className="cat-archived-name">{c.name}</span>
                  {(counts[c.id] ?? 0) > 0 && <span className="muted">{counts[c.id]} 个没结束</span>}
                  <button className="link" onClick={() => run(() => window.api.categories.update(c.id, { archived: false }))}>
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>完成</button>
        </div>
      </div>
    </Dialog>
  )
}

interface RowProps {
  category: Category
  /** 没结束的任务数 */
  open: number
  first: boolean
  last: boolean
  /** 删除时可以改到的其他类别 */
  others: Category[]
  removing: boolean
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>
  onMove: (d: -1 | 1) => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemoved: () => void
}

function CategoryRow({ category: c, open, first, last, others, removing, run, onMove, onAskRemove, onCancelRemove, onRemoved }: RowProps) {
  const [name, setName] = useState(c.name)
  const [mode, setMode] = useState<'keep' | 'move'>('keep')
  const [target, setTarget] = useState(others[0]?.id ?? '')
  useEffect(() => setName(c.name), [c.name])

  const saveName = async () => {
    const v = name.trim()
    if (!v || v === c.name) return setName(c.name)
    if (!(await run(() => window.api.categories.update(c.id, { name: v })))) setName(c.name)
  }

  const remove = async () => {
    const moveTo = open > 0 && mode === 'move' ? target || null : undefined
    if (await run(() => window.api.categories.remove(c.id, moveTo))) onRemoved()
  }

  return (
    <li className={`cat-row ${removing ? 'is-removing' : ''}`}>
      <div className="cat-row-main">
        <div className="cat-order">
          <button type="button" className="secondary icon" disabled={first} aria-label={`上移「${c.name}」`} title="上移" onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" className="secondary icon" disabled={last} aria-label={`下移「${c.name}」`} title="下移" onClick={() => onMove(1)}>
            ↓
          </button>
        </div>
        <ColorPicker value={c.color} label={c.name} onChange={(color) => run(() => window.api.categories.update(c.id, { color }))} />
        <input
          className="cat-name"
          aria-label={`「${c.name}」的名称`}
          maxLength={20}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              // 只撤销这次改名，不关掉整个对话框
              e.preventDefault()
              e.stopPropagation()
              setName(c.name)
            }
          }}
        />
        <span className="cat-open" title="没结束的任务">
          {open} 项
        </span>
        <button type="button" className="link cat-del" disabled={removing} onClick={onAskRemove}>
          删除
        </button>
      </div>

      {removing && (
        <div className="cat-confirm" role="group" aria-label={`删除「${c.name}」`}>
          <p>删除后，选择框和 AI 速记里不会再出现「{c.name}」。已结束的任务、计划和记录照常显示它，之后也可以恢复。</p>
          {open > 0 && (
            <fieldset>
              <legend>还有 {open} 个没结束的任务归在这里</legend>
              <label className="check">
                <input type="radio" name={`rm-${c.id}`} checked={mode === 'keep'} onChange={() => setMode('keep')} />
                保留「{c.name}」，在类别页末尾仍能找到它们
              </label>
              <label className="check">
                <input type="radio" name={`rm-${c.id}`} checked={mode === 'move'} onChange={() => setMode('move')} />
                全部改到
                <select
                  aria-label="改到哪个类别"
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value)
                    setMode('move')
                  }}
                >
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                  <option value="">未分类</option>
                </select>
              </label>
            </fieldset>
          )}
          <div className="cat-confirm-actions">
            <button type="button" className="secondary" onClick={onCancelRemove}>
              取消
            </button>
            <button type="button" className="danger-btn" onClick={remove}>
              删除「{c.name}」
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** 色块按钮，点开选色板里的颜色 */
function ColorPicker({ value, label, onChange }: { value: string; label: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="color-pick"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className="swatch"
        style={{ background: value }}
        aria-label={`「${label}」的颜色`}
        aria-expanded={open}
        title="换颜色"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="color-pop" role="group" aria-label="选择颜色">
          {PALETTE.map((p) => (
            <button
              type="button"
              key={p.color}
              className={`swatch ${p.color === value.toLowerCase() ? 'is-on' : ''}`}
              style={{ background: p.color }}
              aria-label={p.name}
              aria-pressed={p.color === value.toLowerCase()}
              onClick={() => {
                onChange(p.color)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
