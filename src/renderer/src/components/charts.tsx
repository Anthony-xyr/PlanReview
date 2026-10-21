import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatMinutes } from '@shared/format'

/**
 * 周复盘用的几个小图，纯 SVG。规则：
 * 一条 y 轴；柱宽 ≤ 24px、顶部 4px 圆角、底部方角；堆叠段之间 2px 底色缝；
 * 网格线是实线细线；文字用文字色，不用系列色；每个图都有表格视图。
 */

const fm = (m: number) => formatMinutes(Math.round(m)) || '0m'
const GRID = '#e1e0d9'
const AXIS = '#c3c2b7'

/** 容器宽度，跟着窗口变化 */
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(initial)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** 取一个好看的刻度上限（分钟）：30 分钟、1h、2h… */
function niceMax(v: number): { max: number; step: number } {
  const steps = [30, 60, 120, 180, 240, 360, 480, 720]
  for (const step of steps) if (v <= step * 4) return { max: Math.max(step, Math.ceil(v / step) * step), step }
  const step = 720
  return { max: Math.ceil(v / step) * step, step }
}

/** 只有顶部两个角是圆的柱子 */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

export interface Series {
  key: string
  label: string
  color: string
}

interface Tip {
  x: number
  y: number
  title: string
  rows: { color?: string; label: string; value: string }[]
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="chart-tip-row">
          {r.color && <span className="chart-tip-key" style={{ background: r.color }} />}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

export function Legend({ items, shape = 'rect' }: { items: Series[]; shape?: 'rect' | 'line' }) {
  return (
    <ul className="chart-legend">
      {items.map((s) => (
        <li key={s.key}>
          <span className={`chart-legend-key ${shape}`} style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

/** 卡片外壳：标题、说明、图 / 表切换 */
export function ChartCard({ title, sub, table, children }: { title: string; sub?: ReactNode; table: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <section className="chart-card">
      <header className="chart-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="muted">{sub}</p>}
        </div>
        <button className="link" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? '看图' : '看表格'}
        </button>
      </header>
      {asTable ? <div className="chart-table-wrap">{table}</div> : children}
    </section>
  )
}

export interface StackedDay {
  label: string
  sub: string
  /** key → 分钟 */
  values: Record<string, number>
  /** 计划分钟，画成柱子上的一条横线 */
  plan: number
}

/** 每天的实际时长，按大类堆叠；计划用一条细横线标在同一根柱子上（同一条 y 轴） */
export function StackedDays({ days, series, height = 200 }: { days: StackedDay[]; series: Series[]; height?: number }) {
  const [tip, setTip] = useState<Tip | null>(null)
  // 按容器实际宽度画，不缩放：柱宽和字号都是真实像素
  const [ref, W] = useWidth(640)
  const pad = { l: 44, r: 8, t: 10, b: 34 }
  const plotH = height - pad.t - pad.b
  const total = (d: StackedDay) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0)
  const { max, step } = niceMax(Math.max(60, ...days.map((d) => Math.max(total(d), d.plan))))
  const y = (m: number) => pad.t + plotH - (m / max) * plotH
  const band = (W - pad.l - pad.r) / days.length
  const bw = Math.min(24, band * 0.5)
  const GAP = 2

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setTip(null)}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label="每天的实际时长（按大类）与计划">
        {Array.from({ length: max / step + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? AXIS : GRID} strokeWidth={1} />
            <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="chart-tick">
              {fm(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = pad.l + band * i + band / 2
          const x = cx - bw / 2
          const parts = series.map((s) => ({ s, v: d.values[s.key] ?? 0 })).filter((p) => p.v > 0)
          let acc = 0
          const sum = total(d)
          return (
            <g key={d.label}>
              {parts.map((p, j) => {
                const top = y(acc + p.v)
                const bottom = y(acc)
                acc += p.v
                const isTop = j === parts.length - 1
                // 段与段之间留 2px 底色缝：除最底下一段，每段底部收 2px
                const h = Math.max(0, bottom - top - (j > 0 ? GAP : 0))
                return isTop ? (
                  <path key={p.s.key} d={barPath(x, top, bw, h, 4)} fill={p.s.color} />
                ) : (
                  <rect key={p.s.key} x={x} y={top} width={bw} height={h} fill={p.s.color} />
                )
              })}
              {d.plan > 0 && <line x1={x - 6} x2={x + bw + 6} y1={y(d.plan)} y2={y(d.plan)} stroke="#0b0b0b" strokeWidth={2} strokeLinecap="round" />}
              <text x={cx} y={height - pad.b + 16} textAnchor="middle" className="chart-label">
                {d.label}
              </text>
              <text x={cx} y={height - pad.b + 29} textAnchor="middle" className="chart-tick">
                {d.sub}
              </text>
              {/* 命中区：整条竖带，比柱子宽 */}
              <rect
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label} 实际 ${fm(sum)}，计划 ${fm(d.plan)}`}
                onPointerMove={(e) => setTip(tipAt(e, d, sum, parts))}
                onFocus={(e) => setTip(tipAt(e, d, sum, parts))}
                onBlur={() => setTip(null)}
              />
            </g>
          )
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  )

  function tipAt(e: React.PointerEvent | React.FocusEvent, d: StackedDay, sum: number, parts: { s: Series; v: number }[]): Tip {
    const host = (e.currentTarget as SVGElement).closest('.chart')!.getBoundingClientRect()
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    return {
      x: r.left - host.left + r.width / 2,
      y: 4,
      title: `${d.label} ${d.sub}`,
      rows: [
        { label: '实际', value: fm(sum) },
        { label: '计划', value: fm(d.plan) },
        ...[...parts].reverse().map((p) => ({ color: p.s.color, label: p.s.label, value: fm(p.v) }))
      ]
    }
  }
}

export interface CategoryRow {
  key: string
  label: string
  color: string
  plan: number
  actual: number
}

/**
 * 大类的计划 vs 实际：每行两根细横条，实际用大类色，计划用同色的浅色版。
 * 值写在条的末端。
 */
export function CategoryBars({ rows }: { rows: CategoryRow[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.plan, r.actual]))
  return (
    <ul className="cat-bars">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="cat-name">
            <span className="chart-legend-key rect" style={{ background: r.color }} />
            {r.label}
          </span>
          <span className="cat-track">
            <span className="cat-bar act" style={{ width: `${(r.actual / max) * 100}%`, background: r.color }} />
            <span className="cat-val">{fm(r.actual)}</span>
            <span className="cat-bar plan" style={{ width: `${(r.plan / max) * 100}%`, ['--c' as string]: r.color }} />
            <span className="cat-val muted">计划 {fm(r.plan)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export interface DeviationRow {
  key: string
  label: string
  sub: string
  /** 实际 / 估时 */
  ratio: number
}

/**
 * 估时偏差：以 100% 为中线的发散条。超出往右（橙），提前往左（蓝），中线灰色。
 * 横轴封顶 ±200%，超出的在末端写实际倍数。
 */
export function DeviationBars({ rows }: { rows: DeviationRow[] }) {
  const CAP = 2 // 最多画到 ±200%
  const OVER = '#eb6834'
  const UNDER = '#2a78d6'
  return (
    <div className="dev">
      <div className="dev-axis" aria-hidden>
        <span>提前</span>
        <span>和估时一样</span>
        <span>超出</span>
      </div>
      <ul className="dev-rows">
        {rows.map((r) => {
          const d = r.ratio - 1
          const w = (Math.min(Math.abs(d), CAP) / CAP) * 50
          return (
            <li key={r.key} title={`${r.label}：实际是估时的 ${Math.round(r.ratio * 100)}%`}>
              <span className="dev-name">
                {r.label}
                <span className="muted"> {r.sub}</span>
              </span>
              <span className="dev-track">
                <span className="dev-mid" />
                <span
                  className="dev-bar"
                  style={{ width: `${w}%`, background: d >= 0 ? OVER : UNDER, ...(d >= 0 ? { left: '50%', borderRadius: '0 4px 4px 0' } : { right: '50%', borderRadius: '4px 0 0 4px' }) }}
                />
              </span>
              <span className="dev-val">{d >= 0 ? '+' : '−'}{Math.round(Math.abs(d) * 100)}%</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 简单的数据表，所有图的表格视图都用它 */
export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={typeof c === 'number' ? 'num' : ''}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
