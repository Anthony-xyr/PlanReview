import { clamp, snap, SNAP_MIN } from '@shared/time'

export const PX_PER_MIN = 1.1
export const DAY_MIN = 1440

type Kind = 'plan' | 'entry'
type Span = { start: number; end: number }
export type DragPoint = { x: number; y: number }
type Rect = { left: number; top: number; right: number; bottom: number }

export function timelineMinuteAt(clientY: number, gridTop: number): number {
  return clamp((clientY - gridTop) / PX_PER_MIN, 0, DAY_MIN)
}

export function isPlanCopyTarget(point: DragPoint, plan: Rect, viewport: Rect): boolean {
  // 刻度栏一侧多留一点余量，向右进入实际列较深才取消复制。
  const toleranceRight = Math.min(24, (plan.right - plan.left) * 0.12)
  return point.x >= Math.max(viewport.left, plan.left - 36) && point.x < Math.min(viewport.right, plan.right + toleranceRight) &&
    point.y >= Math.max(viewport.top, plan.top) && point.y < Math.min(viewport.bottom, plan.bottom)
}

export interface ItemDrag {
  op: 'move' | 'resize'
  kind: Kind
  id: string
  pointerId: number
  origin: Span
  /** 被日界截断的块仍按完整原时长复制。 */
  copyOrigin?: Span
  grab: number
  pointer: number
  moved: boolean
  copyHeld: boolean
  onPlan: boolean
}

export type Drag = ItemDrag | { op: 'create'; kind: Kind; pointerId: number; anchor: number; cur: number }

export function copyModifier(e: { ctrlKey: boolean; altKey: boolean }, isMac: boolean): boolean {
  return isMac ? e.altKey : e.ctrlKey
}

export function advanceItemDrag(drag: ItemDrag, pointer: number, copyHeld: boolean, onPlan: boolean, horizontalDelta = 0): ItemDrag {
  const moved = drag.moved || Math.abs((pointer - drag.grab) * PX_PER_MIN) > 4 || Math.abs(horizontalDelta) > 4
  return { ...drag, pointer, copyHeld, onPlan, moved }
}

export function itemDrop(drag: ItemDrag): { op: 'move' | 'resize' | 'copy'; span: Span; valid: boolean } {
  const delta = snap(drag.pointer - drag.grab)
  if (drag.op === 'resize') {
    const { start } = drag.origin
    return { op: 'resize', span: { start, end: clamp(snap(drag.pointer), start + 15, DAY_MIN) }, valid: true }
  }
  const copying = drag.kind === 'plan' && drag.copyHeld
  const origin = copying ? drag.copyOrigin ?? drag.origin : drag.origin
  const duration = origin.end - origin.start
  const position = copying ? snap(origin.start + drag.pointer - drag.grab) : origin.start + delta
  const maxStart = Math.max(0, DAY_MIN - duration)
  const start = clamp(position, 0, copying ? Math.floor(maxStart / SNAP_MIN) * SNAP_MIN : maxStart)
  return {
    op: copying ? 'copy' : 'move',
    span: { start, end: start + duration },
    valid: !copying || (drag.onPlan && duration > 0 && duration <= DAY_MIN && start !== origin.start)
  }
}
