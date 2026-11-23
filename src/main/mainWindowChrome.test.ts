import { afterEach, expect, it, vi } from 'vitest'
import { mainWindowChrome, updateMainWindowChrome } from './mainWindowChrome'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

it('leaves the native title bar intact on darwin and only synchronizes the background', () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  expect(mainWindowChrome(true)).toEqual({ backgroundColor: '#1f1f22' })
  const win = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(() => { throw new Error('Windows API called on darwin') }) }
  updateMainWindowChrome(win, false)
  expect(win.setBackgroundColor).toHaveBeenCalledWith('#fbfbfa')
  expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
})

it('creates and updates the Windows title-bar overlay with the same colors as the background', () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  const win = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() }
  expect(mainWindowChrome(false)).toEqual({
    backgroundColor: '#fbfbfa', titleBarStyle: 'hidden', titleBarOverlay: { color: '#fbfbfa', symbolColor: '#1f1e1b', height: 34 }
  })
  updateMainWindowChrome(win, true)
  expect(win.setBackgroundColor).toHaveBeenCalledWith('#1f1f22')
  expect(win.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#1f1f22', symbolColor: '#ecebe8', height: 34 })
})
