// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureHabit, PlanSuggestion } from '@shared/types'
import { MAX_HABITS } from '@shared/types'
import { PlannerDialog } from './PlannerDialog'
import { HabitsDialog } from './HabitsDialog'

let root: Root
let mount: HTMLElement
let api: { habits: { list: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> }; planner: { suggest: ReturnType<typeof vi.fn>; replan: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> } }
const h = (id: string, text: string): CaptureHabit => ({ id, text, enabled: true, example: '', usedCount: 0, lastUsedAt: null, createdAt: '2026-11-04T09:00:00Z', updatedAt: '2026-11-04T09:00:00Z' })
const plan: PlanSuggestion = { day: '2026-11-28', blocks: [{ taskId: null, title: '保留的原草稿', startAt: '2026-11-28T01:00:00Z', endAt: '2026-11-28T02:00:00Z', reason: '' }], notes: [], habitIds: [] }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true }
  HTMLDialogElement.prototype.close ??= function () { this.open = false }
  document.body.innerHTML = '<div id="mount"></div>'
  mount = document.querySelector('#mount')!
  root = createRoot(mount)
  api = { habits: { list: vi.fn(async () => [] as CaptureHabit[]), add: vi.fn() }, planner: { suggest: vi.fn(async () => plan), replan: vi.fn(), accept: vi.fn(async () => ({ created: 1 })) } }
  vi.stubGlobal('api', api)
  Object.defineProperty(window, 'api', { configurable: true, value: api })
})
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals() })
const render = async (element: ReturnType<typeof createElement>) => { await act(async () => { root.render(element) }) }
function button(text: string) {
  const b = [...mount.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  if (!b) throw new Error('按钮不存在：' + text)
  return b
}
const click = async (b: HTMLElement) => { await act(async () => { b.click() }) }
function input(value: string) {
  const field = mount.querySelector<HTMLTextAreaElement>('.cc-correct textarea')!
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
it('默认速记文案保持原样且只读capture', async () => {
  await render(createElement(HabitsDialog, { onClose: vi.fn() }))
  expect(mount.textContent).toContain('AI 拆速记时会照这些习惯理解你的写法，和通用规则冲突时以这里为准。')
  expect(mount.textContent).toContain('还没有。速记时 AI 理解错了，点卡片上的「纠正」写一句哪里不对，确认后就会记在这里。')
  expect(api.habits.list).toHaveBeenCalledExactlyOnceWith('capture')
  expect(mount.textContent).not.toContain('排程习惯')
})
it('排程管理只展示planner，空列表和达到上限均有可读说明', async () => {
  await render(createElement(HabitsDialog, { kind: 'planner', onClose: vi.fn() }))
  expect(mount.textContent).toContain('还没有。可以在下面直接写')
  expect(api.habits.list).toHaveBeenCalledExactlyOnceWith('planner')
  await act(async () => root.render(null))
  api.habits.list.mockResolvedValue(Array.from({ length: MAX_HABITS }, (_, i) => h('p' + i, '排程' + i)))
  await render(createElement(HabitsDialog, { kind: 'planner', onClose: vi.fn() }))
  expect(mount.textContent).toContain('已达到 ' + MAX_HABITS + ' 条上限')
  expect(button('添加').disabled).toBe(true)
  expect(mount.textContent).not.toContain('速记习惯')
})
it('没有草稿时不提供重排，空白纠正按钮不可点', async () => {
  await render(createElement(PlannerDialog, { day: plan.day, mutate: fn => fn(), onClose: vi.fn(), onDone: vi.fn() }))
  expect([...mount.querySelectorAll('button')].some(b => b.textContent === '纠正')).toBe(false)
  await click(button('开始'))
  await click(button('纠正'))
  expect(button('重新排').disabled).toBe(true)
  input('  ')
  expect(button('重新排').disabled).toBe(true)
  expect(api.planner.replan).not.toHaveBeenCalled()
})
it('重排失败显示错误、保留草稿和勾选；成功也不自动写习惯，确认才传入accept', async () => {
  api.planner.replan.mockRejectedValueOnce(new Error('连不上 AI，请稍后再试')).mockResolvedValue({ ...plan, habit: '先阅读再复现', replacesId: null })
  const done = vi.fn()
  await render(createElement(PlannerDialog, { day: plan.day, mutate: fn => fn(), onClose: vi.fn(), onDone: done }))
  await click(button('开始')); await click(button('纠正')); input('先阅读再复现')
  await click(button('重新排'))
  expect(mount.querySelector('[role="alert"]')!.textContent).toBe('连不上 AI，请稍后再试')
  expect(mount.querySelector('.plan-list')!.textContent).toContain('保留的原草稿')
  expect(mount.querySelector<HTMLInputElement>('.plan-list input')!.checked).toBe(true)
  expect(api.habits.add).not.toHaveBeenCalled(); expect(api.planner.accept).not.toHaveBeenCalled()
  await click(button('重新排'))
  expect(mount.textContent).toContain('记住这个排程习惯')
  expect(api.habits.add).not.toHaveBeenCalled(); expect(api.planner.accept).not.toHaveBeenCalled()
  await click(button('排进时间轴（1）'))
  expect(api.planner.accept).toHaveBeenCalledWith(plan.day, plan.blocks, { habitIds: [], habit: { text: '先阅读再复现', replacesId: null, example: '先阅读再复现' } })
  expect(done).toHaveBeenCalledOnce()
})
