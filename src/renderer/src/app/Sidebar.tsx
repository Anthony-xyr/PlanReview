import { Fragment } from 'react'
import type { Category } from '@shared/types'
import {
  pickCategoryView,
  PRIMARY_NAV_ITEMS,
  sameView,
  SIDEBAR_TOOL_SECTIONS,
  type ToolActionId,
  type View
} from './navigation'

interface Props {
  view: View
  categories: Category[]
  inboxCount: number
  showBrand: boolean
  onSelectView: (view: View) => void
  onToolAction: (action: ToolActionId) => void
}

export function Sidebar({ view, categories, inboxCount, showBrand, onSelectView, onToolAction }: Props) {
  const badges = { inboxCount }

  const openCategories = async () => {
    if (view.kind === 'category') return
    const counts = await window.api.categories.openCounts()
    onSelectView(pickCategoryView(categories, counts))
  }

  return (
    <nav className="sidebar" aria-label="视图">
      {showBrand && <div className="brand">计划与复盘</div>}
      {PRIMARY_NAV_ITEMS.map((item) => {
        const active = sameView(view, item.view)
        const count = item.badge ? badges[item.badge] : 0
        return (
          <button
            key={item.view.kind}
            className={`nav-item ${active ? 'is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectView(item.view)}
          >
            <span className="nav-label">{item.label}</span>
            {!!count && <span className="count">{count}</span>}
          </button>
        )
      })}
      <button
        className={`nav-item ${view.kind === 'category' ? 'is-active' : ''}`}
        aria-current={view.kind === 'category' ? 'page' : undefined}
        onClick={openCategories}
      >
        <span className="nav-label">类别</span>
      </button>
      <div className="spacer" />
      {SIDEBAR_TOOL_SECTIONS.map((section) => (
        <Fragment key={section.heading}>
          <div className="nav-heading">{section.heading}</div>
          {section.items.map((item) => (
            <button key={item.id} className="nav-item is-tool" onClick={() => onToolAction(item.id)}>
              {item.label}
            </button>
          ))}
        </Fragment>
      ))}
    </nav>
  )
}
