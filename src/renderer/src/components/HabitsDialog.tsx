import { useEffect, useState } from 'react'
import type { CaptureHabit } from '@shared/types'
import { MAX_HABIT_CHARS, MAX_HABITS } from '@shared/types'
import { Dialog, errorText } from '../ui'

const when = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

/**
 * 速记习惯：纠正 AI 解析后记下的规则。启用的会在每次速记解析时发给 AI，
 * 优先于通用规则。改动立即保存。
 */
export function HabitsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<CaptureHabit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newText, setNewText] = useState('')

  const load = () => window.api.habits.list().then(setList)
  useEffect(() => {
    load()
  }, [])

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
    if (t && (await run(() => window.api.habits.add(t)))) setNewText('')
  }

  if (!list) return null
  const on = list.filter((h) => h.enabled).length

  return (
    <Dialog title="速记习惯" onClose={onClose}>
      <p className="dialog-lead">
        AI 拆速记时会照这些习惯理解你的写法，和通用规则冲突时以这里为准。在速记确认卡片上点「纠正」就能新增；这里可以改写、停用或删除，改动立即保存。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list.length === 0 ? (
        <p className="muted">还没有。速记时 AI 理解错了，点卡片上的「纠正」写一句哪里不对，确认后就会记在这里。</p>
      ) : (
        <>
          <p className="muted">
            {on} 条启用，共 {list.length} / {MAX_HABITS} 条
          </p>
          <ul className="habit-list">
            {list.map((h) => (
              <HabitItem key={h.id} habit={h} run={run} />
            ))}
          </ul>
        </>
      )}

      <form
        className="habit-new"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          aria-label="手动添加一条习惯"
          placeholder="手动加一条，如：「晚上」指 19 点以后"
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

function HabitItem({ habit: h, run }: { habit: CaptureHabit; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [text, setText] = useState(h.text)
  useEffect(() => setText(h.text), [h.text])

  const save = async () => {
    const t = text.trim()
    if (!t || t === h.text) return setText(h.text)
    if (!(await run(() => window.api.habits.update(h.id, { text: t })))) setText(h.text)
  }

  return (
    <li className={`habit ${h.enabled ? '' : 'is-off'}`}>
      <div className="habit-top">
        <label className="check" title={h.enabled ? '停用后 AI 不再参考这条' : '启用'}>
          <input
            type="checkbox"
            aria-label={h.enabled ? `停用「${h.text}」` : `启用「${h.text}」`}
            checked={h.enabled}
            onChange={(e) => run(() => window.api.habits.update(h.id, { enabled: e.target.checked }))}
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
        <button type="button" className="link rs-drop" onClick={() => confirm(`删除「${h.text}」？`) && run(() => window.api.habits.remove(h.id))}>
          删除
        </button>
      </div>
    </li>
  )
}
