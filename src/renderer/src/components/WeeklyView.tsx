import { useEffect, useMemo, useState } from 'react'
import type { AiConfigView, Category, Settings, WeeklyReview, WeekStats } from '@shared/types'
import { OVERRUN_REASONS } from '@shared/types'
import { formatMinutes } from '@shared/format'
import { dayOf, shiftDay } from '@shared/time'
import type { Mutate } from '../ui'
import { ChartCard, CategoryBars, DataTable, DeviationBars, Legend, StackedDays, type Series } from './charts'
import { WeeklyReport } from './WeeklyReport'

interface Props {
  settings: Settings
  categories: Category[]
  version: number
  mutate: Mutate
  onOpenSettings: () => void
}

const WD = '一二三四五六日'
const fm = (m: number) => formatMinutes(Math.round(m)) || '0m'
const NONE_COLOR = '#898781'

export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return shiftDay(day, -((new Date(y, m - 1, d).getDay() + 6) % 7))
}

/** 标题：本周、上周、N 周前 */
export function weekLabel(week: string, thisWeek: string): string {
  const [a, b] = [week, thisWeek].map((w) => {
    const [y, m, d] = w.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  })
  const n = Math.round((b - a) / (7 * 86_400_000))
  return n <= 0 ? '本周' : n === 1 ? '上周' : `${n} 周前`
}

/** 打开页面时看哪一周：本周有内容就看本周，否则看最近一个有内容的周 */
export function startWeek(thisWeek: string, active: string[]): string {
  if (active.includes(thisWeek)) return thisWeek
  return [...active].reverse().find((w) => w < thisWeek) ?? thisWeek
}

/** 翻页：跳到前 / 后一个有内容的周；往后翻到头时回到本周 */
export function stepWeek(week: string, dir: -1 | 1, thisWeek: string, active: string[]): string | null {
  if (dir < 0) return [...active].reverse().find((w) => w < week) ?? null
  if (week >= thisWeek) return null
  return active.find((w) => w > week && w <= thisWeek) ?? thisWeek
}

export function WeeklyView({ settings, categories, version, mutate, onOpenSettings }: Props) {
  const thisWeek = mondayOf(dayOf(new Date(), settings.dayStartHour))
  // null：还在决定打开哪一周
  const [week, setWeek] = useState<string | null>(null)
  const [active, setActive] = useState<string[]>([])
  const [stats, setStats] = useState<WeekStats | null>(null)
  const [review, setReview] = useState<WeeklyReview | null>(null)
  const [ai, setAi] = useState<AiConfigView | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.api.weekly.activeWeeks().then((list) => {
      setActive(list)
      setWeek((w) => w ?? startWeek(thisWeek, list))
    })
  }, [version, thisWeek])

  useEffect(() => {
    if (!week) return
    setLoading(true)
    Promise.all([window.api.weekly.stats(week), window.api.weekly.get(week), window.api.ai.getConfig()]).then(([s, r, a]) => {
      setStats(s)
      setReview(r)
      setAi(a)
      setLoading(false)
    })
  }, [week, version])

  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const catLabel = (id: string | null) => (id ? (catById.get(id)?.name ?? '已删除') : '未分类')
  const catColor = (id: string | null) => (id ? (catById.get(id)?.color ?? NONE_COLOR) : NONE_COLOR)

  if (!stats || !week) return <div className="weekly" />

  // 系列：本周出现过的类别，按类别自身的顺序排（颜色跟着类别走，不按名次重新分配）
  const present = new Set(stats.days.flatMap((d) => Object.keys(d.byCategory)))
  const series: Series[] = [
    ...categories.filter((c) => present.has(c.id)).map((c) => ({ key: c.id, label: c.name, color: c.color })),
    ...(present.has('') ? [{ key: '', label: '未分类', color: NONE_COLOR }] : []),
    ...[...present].filter((k) => k && !catById.has(k)).map((k) => ({ key: k, label: '已删除', color: NONE_COLOR }))
  ]
  const end = shiftDay(week, 6)
  // 只完成或新建了任务、没有计时的周也算有内容
  const noTime = stats.actualMin === 0 && stats.plannedMin === 0
  const empty = noTime && stats.completed === 0 && stats.created === 0
  const prev = stepWeek(week, -1, thisWeek, active)
  const next = stepWeek(week, 1, thisWeek, active)
  // 本周没内容、自动停在了更早的一周
  const skippedThisWeek = week < thisWeek && !active.includes(thisWeek)
  const range = (w: string) => `${w.slice(5).replace('-', '/')} – ${shiftDay(w, 6).slice(5).replace('-', '/')}`
  const lateDays = stats.days.filter((d) => d.sleepWindowMin > 0)
  const lateTotal = lateDays.reduce((s, d) => s + d.sleepWindowMin, 0)
  const reasonLabel = (r: string) => OVERRUN_REASONS.find((x) => x.value === r)?.label ?? '没标原因'
  const overruns = stats.reasons.reduce((s, r) => s + r.count, 0)

  return (
    <div className={`weekly ${loading ? 'is-loading' : ''}`}>
      <header className="page-head">
        <div className="day-nav">
          <button
            className="secondary icon"
            aria-label="上一个有记录的周"
            title={prev ? `上一个有记录的周：${range(prev)}` : '更早没有记录了'}
            disabled={!prev}
            onClick={() => prev && setWeek(prev)}
          >
            ‹
          </button>
          <h1>
            {weekLabel(week, thisWeek)}
            <span className="sub">
              {week.slice(5).replace('-', '/')} – {end.slice(5).replace('-', '/')}
            </span>
          </h1>
          <button
            className="secondary icon"
            aria-label="下一个有记录的周"
            title={next ? (next === thisWeek ? '本周' : `下一个有记录的周：${range(next)}`) : undefined}
            disabled={!next}
            onClick={() => next && setWeek(next)}
          >
            ›
          </button>
          {week !== thisWeek && (
            <button className="secondary" onClick={() => setWeek(thisWeek)}>
              回到本周
            </button>
          )}
        </div>
      </header>

      <div className="weekly-body">
        {skippedThisWeek && (
          <p className="weekly-note" role="status">
            本周（{range(thisWeek)}）还没有计划、记录或任务变动，先显示最近有记录的一周。
            <button className="link" onClick={() => setWeek(thisWeek)}>
              看本周
            </button>
          </p>
        )}
        {empty ? (
          <p className="empty">
            {week === thisWeek
              ? '本周还没有计划、记录或任务变动。在「今天」页排计划、计时，或者完成任务后，这里就会有内容。'
              : '这一周没有计划、记录或任务变动。'}
          </p>
        ) : (
          <>
            {noTime && <p className="weekly-note">这周没有计划和计时，所以只显示任务的完成和新建；时间分布的图表等有记录后再出现。</p>}
            <div className="tiles">
              <Tile label="实际投入" value={fm(stats.actualMin)} sub={`计划 ${fm(stats.plannedMin)}`} />
              <Tile label="计划兑现" value={stats.fulfilment == null ? '—' : `${Math.round(stats.fulfilment * 100)}%`} sub="计划时段里实际做了的比例" />
              <Tile label="完成任务" value={String(stats.completed)} sub={`新建 ${stats.created}${stats.spinOffs ? `，其中延伸 ${stats.spinOffs}` : ''}`} />
              <Tile label="睡眠窗口里" value={fm(lateTotal)} sub={lateDays.length ? `${lateDays.length} 天` : '没有熬夜'} />
            </div>

            {!noTime && (
              <ChartCard
                title="每天的时间去了哪"
                sub="柱子是实际，按类别堆叠；黑色短横线是当天计划的总时长"
                table={
                  <DataTable
                    head={['日期', '实际', '计划', ...series.map((s) => s.label), '睡眠窗口里']}
                    rows={stats.days.map((d, i) => [`周${WD[i]} ${d.day.slice(5)}`, fm(d.actualMin), fm(d.plannedMin), ...series.map((s) => fm(d.byCategory[s.key] ?? 0)), fm(d.sleepWindowMin)])}
                  />
                }
              >
                {series.length > 1 && <Legend items={series} />}
                <StackedDays
                  series={series}
                  days={stats.days.map((d, i) => ({ label: `周${WD[i]}`, sub: d.day.slice(5).replace('-', '/'), values: d.byCategory, plan: d.plannedMin }))}
                />
                {lateDays.length > 0 && (
                  <p className="chart-note">
                    有 {lateDays.length} 天在睡眠窗口（{settings.sleepStart} 起）里还有活动：
                    {lateDays.map((d) => `${d.day.slice(5).replace('-', '/')} ${fm(d.sleepWindowMin)}`).join('、')}
                  </p>
                )}
              </ChartCard>
            )}

            <div className="chart-grid">
              {!noTime && (
                <ChartCard
                  title="各类别：计划和实际"
                  table={<DataTable head={['类别', '实际', '计划']} rows={stats.byCategory.map((c) => [catLabel(c.categoryId), fm(c.actualMin), fm(c.plannedMin)])} />}
                >
                  <CategoryBars rows={stats.byCategory.map((c) => ({ key: c.categoryId ?? '', label: catLabel(c.categoryId), color: catColor(c.categoryId), plan: c.plannedMin, actual: c.actualMin }))} />
                </ChartCard>
              )}

              <ChartCard
                title="估时准不准"
                sub="本周完成、有估时的任务：实际比估时多或少了多少"
                table={<DataTable head={['任务', '估时', '实际', '实际 / 估时']} rows={stats.estimates.map((e) => [e.title, fm(e.estimateMin), fm(e.spentMin), `${Math.round((e.spentMin / e.estimateMin) * 100)}%`])} />}
              >
                {stats.estimates.length ? (
                  <DeviationBars rows={stats.estimates.slice(0, 8).map((e) => ({ key: e.taskId, label: e.title, sub: `${fm(e.spentMin)} / ${fm(e.estimateMin)}`, ratio: e.spentMin / e.estimateMin }))} />
                ) : (
                  <p className="muted">这周没有完成带估时的任务。</p>
                )}
              </ChartCard>

              <ChartCard
                title="超时的原因"
                sub={overruns ? `${overruns} 次明显超出本次计划` : undefined}
                table={<DataTable head={['原因', '次数', '合计超出']} rows={stats.reasons.map((r) => [reasonLabel(r.reason), r.count, fm(r.minutes)])} />}
              >
                {overruns ? (
                  <ul className="reason-list">
                    {stats.reasons.map((r) => (
                      <li key={r.reason}>
                        <span className="reason-name">{reasonLabel(r.reason)}</span>
                        <span className="reason-track">
                          <span className="reason-bar" style={{ width: `${(r.count / Math.max(...stats.reasons.map((x) => x.count))) * 100}%` }} />
                        </span>
                        <span className="reason-val">
                          {r.count} 次 · {fm(r.minutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">这周没有明显超时的记录。</p>
                )}
              </ChartCard>
            </div>
          </>
        )}

        <WeeklyReport week={week} review={review} ai={ai} empty={empty} mutate={mutate} onChange={setReview} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  )
}
