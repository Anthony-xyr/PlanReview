import { useEffect, useState } from 'react'
import type { CaptureDraft, CaptureHabit, CaptureReparse, Category, Task, TaskInput } from '@shared/types'
import { formatMinutes, parseMinutes } from '@shared/format'
import { errorText } from './ui'

/**
 * 速记：开了 AI 解析时先拆字段给用户确认，否则直接存原文。
 * AI 失败时不丢内容，照样存原文并告知。
 */
export function useSmartCapture(opts: { defaults?: TaskInput; onSaved: (t: Task, msg: string) => void; onError: (msg: string) => void }) {
  const [aiOn, setAiOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  const refresh = () =>
    window.api.ai.getConfig().then((c) => setAiOn(c.enabled && c.parseCapture && !!c.baseUrl && !!c.model))
  useEffect(() => {
    refresh()
    return window.api.events.onDataChanged(refresh)
  }, [])

  const saveRaw = async (text: string, note: string) => {
    const t = await window.api.tasks.capture(text, opts.defaults)
    opts.onSaved(t, note)
  }

  /** 返回 true 表示输入框可以清空 */
  const submit = async (text: string): Promise<boolean> => {
    if (!text.trim() || busy) return false
    try {
      if (!aiOn) {
        await saveRaw(text, '已记下')
        return true
      }
      setBusy(true)
      try {
        const r = await window.api.ai.parseCapture(text)
        setPending({ text, draft: r.draft, habitIds: r.habitIds, round: 0 })
      } catch (e) {
        await saveRaw(text, `AI 解析没成功，已存原文（${errorText(e)}）`)
      }
      return true
    } catch (e) {
      opts.onError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 确认保存；habit 是用户勾选要记住的习惯 */
  const confirm = async (d: CaptureDraft, habit?: { text: string; replacesId: string | null }) => {
    if (!pending) return
    try {
      const page = opts.defaults ?? {}
      const t = await window.api.tasks.capture(d.title, {
        categoryId: d.categoryId,
        estimateMin: d.estimateMin,
        dueDate: d.dueDate,
        reviewDate: d.reviewDate,
        notes: d.notes,
        ...page,
        // 页面带的标签和 AI 拆出的合并
        tags: [...new Set([...(d.tags ?? []), ...(page.tags ?? [])])]
      })
      // 任务已经存好，下面两步失败只提示，不影响保存结果
      let msg = '已记下'
      try {
        if (pending.habitIds.length) await window.api.habits.markUsed(pending.habitIds)
        if (habit) {
          await window.api.habits.add(habit.text, pending.text, habit.replacesId)
          msg = habit.replacesId ? '已记下，习惯已更新' : '已记下，也记住了这个习惯'
        }
      } catch (e) {
        msg = `已记下，但习惯没存上（${errorText(e)}）`
      }
      setPending(null)
      opts.onSaved(t, msg)
    } catch (e) {
      opts.onError(errorText(e))
    }
  }

  /** 纠正后 AI 给了新结果：换掉卡片内容，保留历次纠正 */
  const applyReparse = (r: CaptureReparse, feedback: string[]) =>
    setPending((p) => (p ? { ...p, draft: r.draft, habitIds: r.habitIds, feedback, suggestion: r, round: p.round + 1 } : p))

  const keepRaw = async () => {
    if (!pending) return
    try {
      await saveRaw(pending.text, '已存原文')
      setPending(null)
    } catch (e) {
      opts.onError(errorText(e))
    }
  }

  return { aiOn, busy, pending, submit, confirm, keepRaw, applyReparse, cancel: () => setPending(null) }
}

/** 等用户确认的一次 AI 解析 */
interface Pending {
  text: string
  draft: CaptureDraft
  /** AI 说用到的习惯，确认保存时记一次使用 */
  habitIds: string[]
  /** 历次纠正说明，最新的在最后 */
  feedback?: string[]
  /** 最近一次纠正后 AI 概括的习惯 */
  suggestion?: CaptureReparse
  /** 每重新解析一次加一，卡片据此重置字段 */
  round: number
}

type Smart = ReturnType<typeof useSmartCapture>

/**
 * AI 拆分结果确认卡片：每个字段都能改，确认后才保存。
 * 拆得不对可以「纠正」：写一句哪里不对，AI 重新拆，并提出一条可以记住的习惯。
 */
export function CaptureConfirm({
  smart,
  categories,
  lockCategory,
  compact,
  onCancel
}: {
  smart: Smart
  categories: Category[]
  /** 在类别页面里记的，类别固定 */
  lockCategory?: boolean
  compact?: boolean
  onCancel: () => void
}) {
  const pending = smart.pending!
  const [d, setD] = useState(pending.draft)
  const [est, setEst] = useState(formatMinutes(pending.draft.estimateMin))
  const [tags, setTags] = useState(pending.draft.tags.join(' '))
  const [correcting, setCorrecting] = useState(false)
  const [note, setNote] = useState('')
  const [reparsing, setReparsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sug = pending.suggestion
  const [remember, setRemember] = useState(true)
  const [habitText, setHabitText] = useState(sug?.habit ?? '')
  const [habits, setHabits] = useState<CaptureHabit[]>([])
  const estMin = parseMinutes(est)
  const set = <K extends keyof CaptureDraft>(k: K, v: CaptureDraft[K]) => setD((x) => ({ ...x, [k]: v }))

  // 重新解析后用新结果刷新字段
  useEffect(() => {
    setD(pending.draft)
    setEst(formatMinutes(pending.draft.estimateMin))
    setTags(pending.draft.tags.join(' '))
    setHabitText(pending.suggestion?.habit ?? '')
    setRemember(true)
  }, [pending.round])

  // 要显示「会替换哪条」时才去取习惯列表
  useEffect(() => {
    if (sug?.replacesId) window.api.habits.list().then(setHabits)
  }, [sug?.replacesId])
  const replaced = sug?.replacesId ? habits.find((h) => h.id === sug.replacesId) : undefined

  /** 卡片当前的值（含用户手动改过的） */
  const current = (): CaptureDraft => ({ ...d, title: d.title.trim(), estimateMin: estMin ?? null, tags: tags.split(/[\s,，#]+/).filter(Boolean) })

  const reparse = async () => {
    const n = note.trim()
    if (!n || reparsing) return
    const feedback = [...(pending.feedback ?? []), n]
    setReparsing(true)
    setError(null)
    try {
      const r = await window.api.ai.reparseCapture(pending.text, current(), feedback)
      smart.applyReparse(r, feedback)
      setNote('')
      setCorrecting(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setReparsing(false)
    }
  }

  const habitToSave = sug && remember && habitText.trim() ? { text: habitText.trim(), replacesId: sug.replacesId } : undefined

  return (
    <form
      className={`capture-confirm ${compact ? 'is-compact' : ''}`}
      aria-label="确认 AI 拆分结果"
      aria-busy={reparsing}
      onSubmit={(e) => {
        e.preventDefault()
        if (estMin === undefined || !d.title.trim() || reparsing) return
        smart.confirm(current(), habitToSave)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        // Esc 先收起纠正框，再按一次才取消整张卡片
        if (correcting) setCorrecting(false)
        else onCancel()
      }}
    >
      <div className="cc-head">
        <strong>{pending.round ? '按你的纠正重新拆好了' : 'AI 拆好了，确认一下'}</strong>
        <span className="muted cc-orig" title={pending.text}>
          原文：{pending.text}
        </span>
      </div>
      <fieldset className="cc-fields" disabled={reparsing}>
        <label className="field">
          <span>标题</span>
          <input autoFocus value={d.title} onChange={(e) => set('title', e.target.value)} />
        </label>
        <div className="cc-grid">
          {!lockCategory && (
            <label className="field">
              <span>类别</span>
              <select value={d.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value || null)}>
                <option value="">未分类</option>
                {categories
                  .filter((c) => !c.archived)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>估时</span>
            <input value={est} placeholder="不估" aria-invalid={estMin === undefined} onChange={(e) => setEst(e.target.value)} />
          </label>
          <label className="field">
            <span>截止</span>
            <input type="date" value={d.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value || null)} />
          </label>
          <label className="field">
            <span>下次查看</span>
            <input type="date" value={d.reviewDate ?? ''} onChange={(e) => set('reviewDate', e.target.value || null)} />
          </label>
        </div>
        <label className="field">
          <span>标签（空格分隔）</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        {(d.notes || !compact) && (
          <label className="field">
            <span>备注</span>
            <input value={d.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        )}
      </fieldset>

      {sug && (
        <div className="cc-habit">
          {sug.habit ? (
            <>
              <label className="check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {replaced ? '更新这条习惯，以后照这样理解' : '记住这个习惯，以后照这样理解'}
              </label>
              <input
                aria-label="要记住的习惯"
                maxLength={120}
                value={habitText}
                disabled={!remember}
                onChange={(e) => setHabitText(e.target.value)}
              />
              {replaced && remember && <p className="muted cc-replaces">会替换：{replaced.text}</p>}
              <p className="muted">点「确认保存」时才会记下，之后可以在 设置 → AI → 速记习惯 里修改。</p>
            </>
          ) : (
            <p className="muted">这次的纠正只针对这一句，不会记成习惯。</p>
          )}
        </div>
      )}

      {correcting && (
        <div className="cc-correct">
          <label className="field">
            <span>哪里和你的意思不一样？</span>
            <textarea
              autoFocus
              rows={2}
              maxLength={300}
              placeholder="例如：开头的 10.16 是布置作业的日期，不是截止日期"
              value={note}
              disabled={reparsing}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                // 回车重新解析，Shift+回车换行；不要触发外层表单的「确认保存」
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  reparse()
                }
              }}
            />
          </label>
          {pending.feedback && pending.feedback.length > 0 && <p className="muted">会连同前 {pending.feedback.length} 次的说明一起发给 AI。</p>}
          <div className="cc-correct-actions">
            <button type="button" className="link" disabled={reparsing} onClick={() => (setCorrecting(false), setNote(''))}>
              收起
            </button>
            <button type="button" disabled={!note.trim() || reparsing} onClick={reparse}>
              {reparsing ? '重新解析中…' : '重新解析'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="link" onClick={onCancel}>
          取消
        </button>
        {!correcting && (
          <button type="button" className="link" disabled={reparsing} onClick={() => setCorrecting(true)}>
            纠正
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="secondary" disabled={reparsing} onClick={smart.keepRaw}>
          只存原文
        </button>
        <button type="submit" disabled={estMin === undefined || !d.title.trim() || reparsing}>
          确认保存
        </button>
      </div>
    </form>
  )
}
