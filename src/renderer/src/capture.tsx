import { useEffect, useState } from 'react'
import type { CaptureDraft, Category, Task, TaskInput } from '@shared/types'
import { formatMinutes, parseMinutes } from '@shared/format'
import { errorText } from './ui'

/**
 * 速记：开了 AI 解析时先拆字段给用户确认，否则直接存原文。
 * AI 失败时不丢内容，照样存原文并告知。
 */
export function useSmartCapture(opts: { defaults?: TaskInput; onSaved: (t: Task, msg: string) => void; onError: (msg: string) => void }) {
  const [aiOn, setAiOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ text: string; draft: CaptureDraft } | null>(null)

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
        const draft = await window.api.ai.parseCapture(text)
        setPending({ text, draft })
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

  const confirm = async (d: CaptureDraft) => {
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
      setPending(null)
      opts.onSaved(t, '已记下')
    } catch (e) {
      opts.onError(errorText(e))
    }
  }

  const keepRaw = async () => {
    if (!pending) return
    try {
      await saveRaw(pending.text, '已存原文')
      setPending(null)
    } catch (e) {
      opts.onError(errorText(e))
    }
  }

  return { aiOn, busy, pending, submit, confirm, keepRaw, cancel: () => setPending(null) }
}

/** AI 拆分结果确认卡片：每个字段都能改，确认后才保存 */
export function CaptureConfirm({
  original,
  draft,
  categories,
  lockCategory,
  compact,
  onConfirm,
  onKeepRaw,
  onCancel
}: {
  original: string
  draft: CaptureDraft
  categories: Category[]
  /** 在类别页面里记的，类别固定 */
  lockCategory?: boolean
  compact?: boolean
  onConfirm: (d: CaptureDraft) => void
  onKeepRaw: () => void
  onCancel: () => void
}) {
  const [d, setD] = useState(draft)
  const [est, setEst] = useState(formatMinutes(draft.estimateMin))
  const [tags, setTags] = useState(draft.tags.join(' '))
  const estMin = parseMinutes(est)
  const set = <K extends keyof CaptureDraft>(k: K, v: CaptureDraft[K]) => setD((x) => ({ ...x, [k]: v }))

  return (
    <form
      className={`capture-confirm ${compact ? 'is-compact' : ''}`}
      aria-label="确认 AI 拆分结果"
      onSubmit={(e) => {
        e.preventDefault()
        if (estMin === undefined || !d.title.trim()) return
        onConfirm({ ...d, title: d.title.trim(), estimateMin: estMin, tags: tags.split(/[\s,，#]+/).filter(Boolean) })
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="cc-head">
        <strong>AI 拆好了，确认一下</strong>
        <span className="muted cc-orig" title={original}>
          原文：{original}
        </span>
      </div>
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
              {categories.filter((c) => !c.archived).map((c) => (
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
      <div className="dialog-actions">
        <button type="button" className="link" onClick={onCancel}>
          取消
        </button>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={onKeepRaw}>
          只存原文
        </button>
        <button type="submit" disabled={estMin === undefined || !d.title.trim()}>
          确认保存
        </button>
      </div>
    </form>
  )
}
