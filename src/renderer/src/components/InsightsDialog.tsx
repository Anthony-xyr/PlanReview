import { useEffect, useState } from 'react'
import type { Insight } from '@shared/types'
import { Dialog, type Mutate } from '../ui'

const STATUS: Record<Insight['status'], string> = { pending: '待确认', accepted: '已记住', rejected: '不对' }

/** 个人画像：AI 总结、用户确认过的规律。只有「已记住」的会发给 AI 参考 */
export function InsightsDialog({ mutate, onClose }: { mutate: Mutate; onClose: () => void }) {
  const [list, setList] = useState<Insight[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')

  const load = () => window.api.insights.list().then(setList)
  useEffect(() => {
    load()
  }, [])

  const update = async (id: string, patch: { status?: Insight['status']; text?: string }) => {
    if (await mutate(() => window.api.insights.update(id, patch))) {
      setEditing(null)
      load()
    }
  }

  const remove = async (i: Insight) => {
    if (!confirm(`删除「${i.text}」？`)) return
    await mutate(() => window.api.insights.remove(i.id))
    load()
  }

  return (
    <Dialog title="个人画像" onClose={onClose}>
      <p className="dialog-lead">周复盘时 AI 总结出的规律。只有「已记住」的会在之后的复盘和排程里被参考，你可以随时改写或删掉。</p>
      {list.length === 0 ? (
        <p className="muted">还没有。生成周复盘后，AI 会提出候选，确认了才会出现在这里。</p>
      ) : (
        <ul className="insights">
          {list.map((i) => (
            <li key={i.id} className={`ins is-${i.status}`}>
              {editing === i.id ? (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    update(i.id, { text })
                  }}
                >
                  <input autoFocus aria-label="改写" value={text} onChange={(e) => setText(e.target.value)} />
                  <button type="submit" disabled={!text.trim()}>
                    保存
                  </button>
                  <button type="button" className="link" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </form>
              ) : (
                <>
                  <div className="ins-text">
                    <span className="badge">{STATUS[i.status]}</span> {i.text}
                  </div>
                  {i.evidence && <div className="sug-evidence">依据：{i.evidence}</div>}
                  <div className="sug-actions">
                    {i.status !== 'accepted' && <button className="secondary" onClick={() => update(i.id, { status: 'accepted' })}>记住</button>}
                    {i.status === 'accepted' && <button className="link" onClick={() => update(i.id, { status: 'rejected' })}>不再参考</button>}
                    {i.status === 'pending' && <button className="link" onClick={() => update(i.id, { status: 'rejected' })}>不对</button>}
                    <button className="link" onClick={() => (setEditing(i.id), setText(i.text))}>
                      改写
                    </button>
                    <button className="link rs-drop" onClick={() => remove(i)}>
                      删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>关闭</button>
      </div>
    </Dialog>
  )
}
