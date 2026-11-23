import { describe, expect, it } from 'vitest'
import { advanceItemDrag, copyModifier, itemDrop, type ItemDrag } from './timelineDrag'

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
})
