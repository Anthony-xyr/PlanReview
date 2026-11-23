import { describe, expect, it } from 'vitest'
import { advanceItemDrag, copyModifier, isPlanCopyTarget, itemDrop, PX_PER_MIN, timelineMinuteAt, type ItemDrag } from './timelineDrag'

const drag: ItemDrag = {
  op: 'move', kind: 'plan', id: 'block', pointerId: 1,
  origin: { start: 60, end: 120 }, grab: 65, pointer: 65, moved: false, copyHeld: false, onPlan: true
}

describe('时间轴拖动复制', () => {
  it('Windows/Linux 用 Ctrl，macOS 用 Option', () => {
    expect(copyModifier({ ctrlKey: true, altKey: false }, false)).toBe(true)
    expect(copyModifier({ ctrlKey: false, altKey: true }, false)).toBe(false)
    expect(copyModifier({ ctrlKey: true, altKey: false }, true)).toBe(false)
    expect(copyModifier({ ctrlKey: false, altKey: true }, true)).toBe(true)
  })

  it('修饰键中途切换时用原位置重新计算；未对齐的源块也吸附落点', () => {
    const initial = { ...drag, origin: { start: 63, end: 113 } }
    const moved = advanceItemDrag(initial, 82, false, true)
    expect(itemDrop(moved)).toEqual({ op: 'move', span: { start: 78, end: 128 }, valid: true })
    const copied = { ...moved, copyHeld: true }
    expect(itemDrop(copied)).toEqual({ op: 'copy', span: { start: 75, end: 125 }, valid: true })
    expect(itemDrop({ ...copied, copyHeld: false })).toEqual(itemDrop(moved))
    expect(initial.origin).toEqual({ start: 63, end: 113 })
  })

  it('贴合日界并保留完整时长，包括源块原本跨日的情况', () => {
    const copy = { ...drag, origin: { start: 0, end: 40 }, copyOrigin: { start: -20, end: 40 }, grab: 5 }
    expect(itemDrop(advanceItemDrag(copy, 5, true, true)).span).toEqual({ start: 0, end: 60 })
    expect(itemDrop(advanceItemDrag(copy, 1440, true, true)).span).toEqual({ start: 1380, end: 1440 })
    expect(itemDrop(advanceItemDrag({ ...copy, copyOrigin: { start: -20, end: 30 } }, 1440, true, true)).span)
      .toEqual({ start: 1380, end: 1430 })
    expect(itemDrop(advanceItemDrag({ ...copy, copyOrigin: { start: -60, end: 1440 } }, 200, true, true)).valid).toBe(false)
  })

  it('离开计划列、没有换落点时不复制，实际列与拉伸不复制', () => {
    expect(itemDrop(advanceItemDrag(drag, 160, true, false)).valid).toBe(false)
    expect(itemDrop(advanceItemDrag(drag, 67, true, true)).valid).toBe(false)
    expect(itemDrop(advanceItemDrag({ ...drag, kind: 'entry' }, 160, true, false)).op).toBe('move')
    expect(itemDrop(advanceItemDrag({ ...drag, op: 'resize' }, 160, true, true)).op).toBe('resize')
    expect(advanceItemDrag(drag, 67, true, true).moved).toBe(false)
  })

  it('允许在刻度附近及轻微跨分隔线，拒绝深入实际列或离开可见时间轴', () => {
    const plan = { left: 156, right: 356, top: -10, bottom: 1574 }
    const viewport = { left: 100, right: 556, top: 20, bottom: 650 }
    for (const x of [plan.left - 15, plan.right + 12]) expect(isPlanCopyTarget({ x, y: 80 }, plan, viewport)).toBe(true)
    for (const point of [{ x: 360, y: 10 }, { x: 384, y: 80 }, { x: 110, y: 80 }, { x: 200, y: 650 }]) {
      expect(isPlanCopyTarget(point, plan, viewport)).toBe(false)
    }
    expect(advanceItemDrag(drag, drag.grab, true, false, 200).moved).toBe(true)
  })

  it('滚动后固定光标读到新的分钟，松手按新的吸附位置保留原时长', () => {
    const y = 100
    const top = y - drag.grab * PX_PER_MIN
    const afterScroll = timelineMinuteAt(y, top - 46 * PX_PER_MIN)
    expect(itemDrop(advanceItemDrag(drag, afterScroll, true, true)).span).toEqual({ start: 105, end: 165 })
    expect(timelineMinuteAt(y, y + 5)).toBe(0)
  })
})
