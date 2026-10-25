import { useEffect, useState } from 'react'
import type { Category, Resurface, ResurfaceAction, StartTimerInput, Task } from '@shared/types'
import type { Mutate } from '../ui'
import { shiftDay } from '@shared/time'

interface Props {
  day: string
  /** 只在今天显示；看别的日子时不打扰 */
  isToday: boolean
  version: number
  categories: Category[]
  mutate: Mutate
  onStartTimer: (input: StartTimerInput) => void
  onOpenInbox: () => void
  onOpenReview: (day: string) => void
  notify: (text: string) => void
  /** 告诉外面这里列出了哪些任务，避免重复显示 */
  onSurfaced: (ids: Set<string>) => void
}

const LATER = [
  { days: 3, label: '3 天后' },
  { days: 7, label: '下周' },
  { days: 30, label: '下个月' }
]

/**
 * 「今天」页左栏顶部的找回区：到了下次查看日的、随机抽到的旧事项、收件箱积压提示。
 * 每条都可以一步处理掉，处理完就从这里消失。
 */
export function ResurfacePanel({ day, isToday, version, categories, mutate, onStartTimer, onOpenInbox, onOpenReview, notify, onSurfaced }: Props) {
  const [data, setData] = useState<Resurface | null>(null)
  const [tick, setTick] = useState(0)
  const catById = new Map(categories.map((c) => [c.id, c]))

  useEffect(() => {
    if (!isToday) return setData(null)
    window.api.resurface.get(day).then(setData)
  }, [day, isToday, version, tick])

  useEffect(() => {
    const ids = data ? [...data.due, ...data.picks, ...(data.firstThing ? [data.firstThing] : [])].map((t) => t.id) : []
    onSurfaced(new Set(ids))
  }, [data, onSurfaced])

  if (!data) return null
  const showTidy = data.tidyNeeded && !data.tidyDismissed
  if (!data.due.length && !data.picks.length && !showTidy && !data.firstThing && !data.yesterdayUnreviewed) return null

  const act = async (t: Task, action: ResurfaceAction, msg: string) => {
    if (await mutate(() => window.api.resurface.act(t.id, action))) notify(msg)
  }

  const reroll = async () => {
    await mutate(() => window.api.resurface.reroll(day))
    setTick((n) => n + 1)
  }

  const card = (t: Task, kind: 'due' | 'pick') => {
    const c = t.categoryId ? catById.get(t.categoryId) : undefined
    return (
      <li key={t.id} className={`rs-item rs-${kind}`} style={{ ['--c' as string]: c?.color ?? 'var(--faint)' }}>
        <div className="rs-title">{t.title}</div>
        <div className="rs-meta">
          {kind === 'due' && t.reviewDate && t.reviewDate < day && <span>原定 {t.reviewDate.slice(5)} 再看</span>}
          {t.status === 'inbox' && <span className="badge">收件箱</span>}
          {t.nextStep && <span className="next">下一步：{t.nextStep}</span>}
          {!t.nextStep && t.notes && <span className="muted">{t.notes.slice(0, 40)}</span>}
        </div>
        <div className="rs-actions">
          <button className="link" onClick={() => onStartTimer({ taskId: t.id })}>
            ▶ 现在做
          </button>
          {t.status === 'inbox' || kind === 'due' ? (
            <button className="link" onClick={() => act(t, { kind: 'keep' }, `「${t.title}」放进待办了`)}>
              放进待办
            </button>
          ) : null}
          <details className="rs-later">
            <summary className="link">以后再看</summary>
            <div className="rs-later-menu">
              {LATER.map((l) => (
                <button key={l.days} className="secondary" onClick={() => act(t, { kind: 'later', days: l.days }, `${l.label}再提醒你`)}>
                  {l.label}
                </button>
              ))}
              {kind === 'due' && (
                <button className="secondary" onClick={() => act(t, { kind: 'clear' }, '不再按日期提醒，任务还在')}>
                  不用提醒
                </button>
              )}
            </div>
          </details>
          <button className="link rs-drop" onClick={() => act(t, { kind: 'drop' }, `「${t.title}」标为不做了`)}>
            不做了
          </button>
        </div>
      </li>
    )
  }

  return (
    <section className="resurface" aria-label="找回">
      {data.firstThing && (
        <div className="rs-first">
          <div className="muted">昨天说好今天先做</div>
          <div className="rs-title">{data.firstThing.title}</div>
          {data.firstThing.nextStep && <div className="next">下一步：{data.firstThing.nextStep}</div>}
          <button className="secondary" onClick={() => onStartTimer({ taskId: data.firstThing!.id })}>
            ▶ 开始
          </button>
        </div>
      )}
      {data.yesterdayUnreviewed && (
        <div className="rs-tidy">
          <div>昨天还没复盘。花两分钟看看计划和实际差在哪？</div>
          <div className="rs-actions">
            <button className="secondary" onClick={() => onOpenReview(shiftDay(day, -1))}>
              复盘昨天
            </button>
          </div>
        </div>
      )}
      {data.due.length > 0 && (
        <>
          <h2>该回头看看</h2>
          <p className="muted">之前说好今天再看的事。</p>
          <ul className="rs-list">{data.due.map((t) => card(t, 'due'))}</ul>
        </>
      )}
      {data.picks.length > 0 && (
        <>
          <h2 className="rs-head">
            随手翻到
            <button className="link" onClick={reroll} title="换一批">
              换一批
            </button>
          </h2>
          <p className="muted">从没排期的事里抽的，越久没碰越容易被抽到。</p>
          <ul className="rs-list">{data.picks.map((t) => card(t, 'pick'))}</ul>
        </>
      )}
      {showTidy && (
        <div className="rs-tidy">
          <div>
            收件箱有 <strong>{data.inbox.count}</strong> 条
            {data.inbox.oldestDays > 0 && <>，最早的放了 {data.inbox.oldestDays} 天</>}。花几分钟整理一下？
          </div>
          <div className="rs-actions">
            <button className="secondary" onClick={onOpenInbox}>
              去整理
            </button>
            <button
              className="link"
              onClick={async () => {
                await mutate(() => window.api.resurface.dismissTidy(day))
                setTick((n) => n + 1)
              }}
            >
              今天先不
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
