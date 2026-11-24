// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateConfirmation } from '@shared/update'
import { UpdateConfirmDialog } from './UpdateConfirmDialog'

const confirmation: UpdateConfirmation = { id: 'request-1', source: 'main', version: '0.3.0', timerTitle: '阶段复盘'.repeat(70) }
let mount: HTMLElement
let trigger: HTMLButtonElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom 不实现顶部模态层。只补开关，真实模态行为由打包后的 Electron 冒烟覆盖。
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true }
  HTMLDialogElement.prototype.close ??= function () { this.open = false }
  document.body.innerHTML = '<button id="trigger">重启并更新</button><div id="mount"></div>'
  trigger = document.querySelector<HTMLButtonElement>('#trigger')!
  mount = document.getElementById('mount')!
  root = createRoot(mount)
  trigger.focus()
})
afterEach(() => {
  act(() => { root.unmount() })
  vi.unstubAllGlobals()
})

function open(prompt = confirmation, onDecision = vi.fn(async (_id: string, _accept: boolean) => {})) {
  act(() => root.render(createElement(StrictMode, null, createElement(UpdateConfirmDialog, {
    confirmation: prompt, returnFocus: trigger, onDecision, onError: vi.fn()
  }))))
  const dialog = mount.querySelector('dialog')!
  const [later, update] = dialog.querySelectorAll<HTMLButtonElement>('button')
  return { dialog, later, update, onDecision }
}
function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  act(() => { document.activeElement!.dispatchEvent(event) })
  return event
}

it('对话框关联标题和说明，先聚焦稍后再说', () => {
  const { dialog, later } = open()
  expect(dialog.open).toBe(true)
  expect(dialog.getAttribute('role')).toBe('alertdialog')
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('现在更新吗？')
  const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!
  expect(description.textContent).toContain(confirmation.timerTitle)
  expect(description.textContent).toContain('安装耗时也计入已用时')
  expect(document.activeElement).toBe(later)
})

it('Tab 和 Shift+Tab 均只在两个选项之间循环', () => {
  const { later, update, onDecision } = open()
  expect(press('Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(update)
  press('Tab')
  expect(document.activeElement).toBe(later)
  press('Tab', true)
  expect(document.activeElement).toBe(update)
  press('Tab', true)
  expect(document.activeElement).toBe(later)
  expect(onDecision).not.toHaveBeenCalled()
})

it('Esc 只取消一次，关闭后还原触发按钮的焦点', async () => {
  const { onDecision } = open()
  expect(press('Escape').defaultPrevented).toBe(true)
  press('Escape')
  expect(onDecision).toHaveBeenCalledExactlyOnceWith(confirmation.id, false)
  await act(async () => { root.render(null) })
  expect(document.activeElement).toBe(trigger)
})

it('点遮罩不关闭，点按钮才确认，新请求重新聚焦取消', async () => {
  const { dialog, later, update, onDecision } = open()
  const backdrop = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  act(() => { dialog.dispatchEvent(backdrop) })
  expect(backdrop.defaultPrevented).toBe(true)
  expect(dialog.open).toBe(true)
  expect(onDecision).not.toHaveBeenCalled()
  update.focus()
  const next = { ...confirmation, id: 'request-2' }
  open(next, onDecision)
  expect(document.activeElement).toBe(later)
  await act(async () => { update.click() })
  expect(onDecision).toHaveBeenCalledExactlyOnceWith(next.id, true)
})
