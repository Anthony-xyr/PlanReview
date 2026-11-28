import { useEffect, useState } from 'react'
import type { CaptureHabit, HabitKind } from '@shared/types'
import { MAX_HABIT_CHARS, MAX_HABITS } from '@shared/types'
import { Dialog, errorText } from '../ui'
import './HabitsDialog.css'

const when = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

/** 两种习惯的文案；功能完全一样 */
const COPY: Record<HabitKind, { title: string; lead: string; empty: string; placeholder: string }> = {
  capture: {
    title: '速记习惯',
    lead: 'AI 拆速记时会照这些习惯理解你的写法，和通用规则冲突时以这里为准。在速记确认卡片上点「纠正」就能新增；这里可以改写、停用或删除，改动立即保存。',
    empty: '还没有。速记时 AI 理解错了，点卡片上的「纠正」写一句哪里不对，确认后就会记在这里。',
    placeholder: '手动加一条，如：「晚上」指 19 点以后'
  },
  planner: {
    title: '排程习惯',
    lead: '「请 AI 排一下」时会照这些习惯安排，只有这次填的要求比它们优先。在排程结果里点「纠正」就能新增；这里可以改写、停用或删除，改动立即保存。',
    empty: '还没有。可以在下面直接写，也可以在 AI 排好之后点「纠正」，排进时间轴时就会记在这里。',
    placeholder: '手动加一条，如：18:00–19:00 吃晚饭，不排任务'
  }
}

/**
 * 习惯管理：纠正 AI 后记下的规则。启用的会在每次对应的 AI 调用里发出去。
 * 改动立即保存。
 */
export function HabitsDialog({ kind = 'capture', onClose }: { kind?: HabitKind; onClose: () => void }) {
  const [list, setList] = useState<CaptureHabit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newText, setNewText] = useState('')
  const copy = COPY[kind]

  const load = () => window.api.habits.list(kind).then(setList).catch((e) => { setError(errorText(e)); setList([]) })
  useEffect(() => {
    load()
  }, [kind])

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      load()
    }
  }

  const add = async () => {
    const t = newText.trim()
    if (t && (await run(() => window.api.habits.add(t, '', null, kind)))) setNewText('')
  }

  if (!list) return null
  const on = list.filter((h) => h.enabled).length

  return (
    <Dialog title={copy.title} onClose={onClose}>
      <p className="dialog-lead">{copy.lead}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list.length === 0 ? (
        <p className="muted">{copy.empty}</p>
      ) : (
        <>
          <p className="muted">
            {on} 条启用，共 {list.length} / {MAX_HABITS} 条
          </p>
          <ul className="habit-list">
            {list.map((h) => (
              <HabitItem key={h.id} habit={h} kind={kind} run={run} />
            ))}
          </ul>
        </>
      )}

      {kind === 'planner' && list.length >= MAX_HABITS && <p className="muted" role="status">已达到 {MAX_HABITS} 条上限，可以改写已有习惯，或先删除不用的再添加。</p>}
      <form
        className="habit-new"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          aria-label="手动添加一条习惯"
          placeholder={copy.placeholder}
          maxLength={MAX_HABIT_CHARS}
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={!newText.trim() || list.length >= MAX_HABITS}>
          添加
        </button>
      </form>

      <div className="dialog-actions">
        <button onClick={onClose}>完成</button>
      </div>
    </Dialog>
  )
}

function HabitItem({ habit: h, kind, run }: { habit: CaptureHabit; kind: HabitKind; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [text, setText] = useState(h.text)
  useEffect(() => setText(h.text), [h.text])

  const save = async () => {
    const t = text.trim()
    if (!t || t === h.text) return setText(h.text)
    if (!(await run(() => window.api.habits.update(h.id, { text: t }, kind)))) setText(h.text)
  }

  return (
    <li className={`habit ${h.enabled ? '' : 'is-off'}`}>
      <div className="habit-top">
        <label className="check" title={h.enabled ? '停用后 AI 不再参考这条' : '启用'}>
          <input
            type="checkbox"
            aria-label={h.enabled ? `停用「${h.text}」` : `启用「${h.text}」`}
            checked={h.enabled}
            onChange={(e) => run(() => window.api.habits.update(h.id, { enabled: e.target.checked }, kind))}
          />
        </label>
        <textarea
          className="habit-text"
          rows={2}
          aria-label="习惯内容"
          maxLength={MAX_HABIT_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              // 只撤销这次改写，不关掉对话框
              e.preventDefault()
              e.stopPropagation()
              setText(h.text)
            }
          }}
        />
      </div>
      <div className="habit-meta">
        {h.example && (
          <span className="habit-ex" title={h.example}>
            来自：{h.example}
          </span>
        )}
        <span>{h.usedCount ? `用过 ${h.usedCount} 次，最近 ${when(h.lastUsedAt!)}` : '还没用到'}</span>
        <span>{when(h.createdAt)} 记下</span>
        <span className="spacer" />
        <button type="button" className="link rs-drop" onClick={() => confirm(`删除「${h.text}」？`) && run(() => window.api.habits.remove(h.id, kind))}>
          删除
        </button>
      </div>
    </li>
  )
}
