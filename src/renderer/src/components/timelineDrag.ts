import { clamp, snap, SNAP_MIN } from '@shared/time'

export const PX_PER_MIN = 1.1
export const DAY_MIN = 1440

type Kind = 'plan' | 'entry'
type Span = { start: number; end: number }

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

export function advanceItemDrag(drag: ItemDrag, pointer: number, copyHeld: boolean, onPlan: boolean): ItemDrag {
  const moved = drag.moved || Math.abs((pointer - drag.grab) * PX_PER_MIN) > 4
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
