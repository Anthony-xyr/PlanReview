// Declarative navigation definitions, dialog union, and main-command routing.

import type { Category, MainCommand } from '@shared/types'
import { dayOf } from '@shared/time'
import type { TaskViewKind } from '../components/TasksView'

export type View = { kind: 'today' } | { kind: 'weekly' } | TaskViewKind

export type ActiveDialog =
  | { kind: 'stop' }
  | { kind: 'extend' }
  | { kind: 'wrap-up' }
  | { kind: 'insights' }
  | { kind: 'planner'; day: string }
  | { kind: 'review'; day: string }
  | { kind: 'import' }
  | { kind: 'settings' }

export interface NavItemConfig {
  view: Extract<View, { kind: 'today' | 'inbox' | 'active' | 'done' | 'weekly' }>
  label: string
  badge?: 'inboxCount'
}

export type ToolActionId = 'review' | 'wrap-up' | 'insights' | 'import' | 'float' | 'settings'

export interface ToolSectionConfig {
  heading: string
  items: { id: ToolActionId; label: string }[]
}

export const PRIMARY_NAV_ITEMS: readonly NavItemConfig[] = [
  { view: { kind: 'today' }, label: '今天' },
  { view: { kind: 'inbox' }, label: '收件箱', badge: 'inboxCount' },
  { view: { kind: 'active' }, label: '待办' },
  { view: { kind: 'done' }, label: '已结束' },
  { view: { kind: 'weekly' }, label: '周复盘' }
]

export const SIDEBAR_TOOL_SECTIONS: readonly ToolSectionConfig[] = [
  {
    heading: '复盘',
    items: [
      { id: 'review', label: '今日复盘' },
      { id: 'wrap-up', label: '收尾' },
      { id: 'insights', label: '个人画像' }
    ]
  },
  {
    heading: '工具',
    items: [
      { id: 'import', label: '导入课表' },
      { id: 'float', label: '显示悬浮窗' },
      { id: 'settings', label: '设置' }
    ]
  }
]

export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'category' && b.kind === 'category') return a.id === b.id
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag
  return true
}

/** Pick the first active category that has open tasks, falling back to the first active category. */
export function pickCategoryView(categories: Category[], openCounts: Record<string, number>): Extract<View, { kind: 'category' }> {
  const firstActive = categories.find((c) => !c.archived)?.id ?? null
  const firstWithOpen = categories.find((c) => !c.archived && openCounts[c.id])?.id
  return { kind: 'category', id: firstWithOpen ?? firstActive }
}

export type CommandEffect =
  | { type: 'view'; view: View }
  | { type: 'dialog'; dialog: ActiveDialog }

export function resolveCommandAction(cmd: MainCommand, dayStartHour: number, now = new Date()): CommandEffect {
  switch (cmd) {
    case 'stop':
      return { type: 'dialog', dialog: { kind: 'stop' } }
    case 'wrap-up':
      return { type: 'dialog', dialog: { kind: 'wrap-up' } }
    case 'review':
      return { type: 'dialog', dialog: { kind: 'review', day: dayOf(now, dayStartHour) } }
    case 'weekly':
      return { type: 'view', view: { kind: 'weekly' } }
    case 'today':
      return { type: 'view', view: { kind: 'today' } }
  }
}
