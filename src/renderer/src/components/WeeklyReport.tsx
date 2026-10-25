import { useEffect, useRef, useState } from 'react'
import type { AiConfigView, Insight, Suggestion, WeeklyReview } from '@shared/types'
import { errorText, type Mutate } from '../ui'

interface Props {
  week: string
  review: WeeklyReview | null
  ai: AiConfigView | null
  empty: boolean
  mutate: Mutate
  onChange: (r: WeeklyReview) => void
  onOpenSettings: () => void
}

const SETTING_LABEL: Record<string, string> = {
  defaultSessionMin: '默认本次时长',
  extendStepMin: '每次延长',
  sleepLeadMin: '睡前提醒提前',
  leaveTime: '离开自习室时间',
  sleepStart: '睡眠窗口开始'
}

/** 把建议附带的改动写成人话，让用户知道点了「采纳」会发生什么 */
function actionText(s: Suggestion): string | null {
  const a = s.action
  if (a.kind === 'setting') return `把「${SETTING_LABEL[a.key]}」改成 ${typeof a.value === 'number' ? `${a.value} 分钟` : a.value}`
  if (a.kind === 'estimate') return `把这个任务的估时改成 ${a.estimateMin} 分钟`
  if (a.kind === 'insight') return `记进个人画像：${a.text}`
  return null
}

export function WeeklyReport({ week, review, ai, empty, mutate, onChange, onOpenSettings }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [insights, setInsights] = useState<Insight[]>([])
  const chatEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.insights.list().then(setInsights)
  }, [review])

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [review?.messages.length])

  const aiReady = !!ai && ai.enabled && !!ai.baseUrl && !!ai.model

  const generate = async () => {
    if (review?.report && !confirm('重新生成会替换现在的报告，追问记录也会清空。继续吗？')) return
    setBusy(true)
    setError(null)
    try {
      onChange(await window.api.weekly.generate(week))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const ask = async () => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setError(null)
    try {
      await window.api.weekly.ask(week, q)
      setQuestion('')
      onChange((await window.api.weekly.get(week))!)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setAsking(false)
    }
  }

  const act = async (s: Suggestion, kind: 'apply' | 'dismiss') => {
    const r = await mutate(() => (kind === 'apply' ? window.api.weekly.apply(week, s.id) : window.api.weekly.dismiss(week, s.id)))
    if (r) onChange(r)
  }

  const setInsight = async (i: Insight, status: Insight['status']) => {
    if (await mutate(() => window.api.insights.update(i.id, { status }))) setInsights(await window.api.insights.list())
  }

  const pending = insights.filter((i) => i.status === 'pending' && i.sourceWeek === week)
  const r = review?.report

  return (
    <section className="weekly-ai" aria-label="AI 深度复盘">
      <header className="chart-head">
        <div>
          <h3>AI 深度复盘</h3>
          <p className="muted">根据上面的数据和你写的每日复盘给建议。所有改动都要你点「采纳」才会生效。</p>
        </div>
        {aiReady && !empty && (
          <button onClick={generate} disabled={busy}>
            {busy ? '正在分析…' : r ? '重新生成' : '生成这一周的复盘'}
          </button>
        )}
      </header>

      {!aiReady && (
        <p className="muted">
          还没有配置 AI。<button className="link" onClick={onOpenSettings}>去设置</button>
          。不用 AI 也能看上面的统计。
        </p>
      )}
      {aiReady && empty && <p className="muted">这一周没有数据，先不生成。</p>}
      {aiReady && !empty && !r && !busy && <p className="muted">会把这一周的统计、每日复盘里写的话、已确认的个人画像发给你配置的 AI 服务。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {r && (
        <div className="report">
          {r.summary && <p className="report-summary">{r.summary}</p>}
          <div className="report-cols">
            {r.wins.length > 0 && (
              <div>
                <h4>做得好的</h4>
                <ul>{r.wins.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {r.patterns.length > 0 && (
              <div>
                <h4>观察到的规律</h4>
                <ul>{r.patterns.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
          </div>

          {r.suggestions.length > 0 && (
            <>
              <h4>建议</h4>
              <ul className="suggestions">
                {r.suggestions.map((s) => {
                  const change = actionText(s)
                  return (
                    <li key={s.id} className={`sug is-${s.status}`}>
                      <div className="sug-title">{s.title}</div>
                      {s.evidence && <div className="sug-evidence">依据：{s.evidence}</div>}
                      {change && <div className="sug-change">采纳后：{change}</div>}
                      <div className="sug-actions">
                        {s.status === 'open' ? (
                          <>
                            {change ? <button onClick={() => act(s, 'apply')}>采纳</button> : <button className="secondary" onClick={() => act(s, 'apply')}>知道了</button>}
                            <button className="link" onClick={() => act(s, 'dismiss')}>不采纳</button>
                          </>
                        ) : (
                          <span className="muted">{s.status === 'applied' ? (change ? '已采纳' : '已读') : '没有采纳'}</span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {pending.length > 0 && (
            <>
              <h4>可能值得记住的规律</h4>
              <p className="muted">确认后会写进个人画像，以后的复盘和排程会参考。</p>
              <ul className="suggestions">
                {pending.map((i) => (
                  <li key={i.id} className="sug">
                    <div className="sug-title">{i.text}</div>
                    {i.evidence && <div className="sug-evidence">依据：{i.evidence}</div>}
                    <div className="sug-actions">
                      <button onClick={() => setInsight(i, 'accepted')}>记住</button>
                      <button className="link" onClick={() => setInsight(i, 'rejected')}>不对</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>追问</h4>
          <div className="chat">
            {review!.messages.length === 0 && <p className="muted">对报告有疑问可以直接问，比如「为什么说周二效率低？」</p>}
            {review!.messages.map((m) => (
              <div key={m.id} className={`msg is-${m.role}`}>
                {m.content}
              </div>
            ))}
            {asking && <div className="msg is-assistant muted">正在想…</div>}
            <div ref={chatEnd} />
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault()
              ask()
            }}
          >
            <input aria-label="追问" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="问点什么…" disabled={asking} />
            <button type="submit" disabled={!question.trim() || asking}>
              发送
            </button>
          </form>
          <p className="muted report-meta">由 {review!.model} 生成</p>
        </div>
      )}
    </section>
  )
}
