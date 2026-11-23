import { describe, expect, it } from 'vitest'
import { toAccelerator } from './accelerator'

const keyboard = (code: string, key: string, patch: Partial<KeyboardEvent> = {}) => ({
  code, key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...patch
})

describe('shortcut recording', () => {
  it('uses physical keys when macOS Option changes the emitted character', () => {
    expect(toAccelerator(keyboard('KeyA', 'å'), 'darwin')).toBe('Option+A')
    expect(toAccelerator(keyboard('Digit1', '¡', { shiftKey: true }), 'darwin')).toBe('Option+Shift+1')
    expect(toAccelerator(keyboard('KeyE', 'Dead'), 'darwin')).toBe('Option+E')
  })

  it('accepts Electron function and navigation keys, using the documented names', () => {
    expect(toAccelerator(keyboard('F12', 'F12', { metaKey: true }), 'darwin')).toBe('Option+Command+F12')
    expect(toAccelerator(keyboard('F24', 'F24'), 'darwin')).toBe('Option+F24')
    expect(toAccelerator(keyboard('ArrowLeft', 'ArrowLeft'), 'win32')).toBe('Alt+Left')
    expect(toAccelerator(keyboard('NumpadAdd', '+'), 'win32')).toBe('Alt+numadd')
  })

  it('rejects unknown dead keys, bare modifiers, input composition and unsupported keys', () => {
    expect(toAccelerator(keyboard('Unidentified', 'Dead'), 'darwin')).toBeNull()
    expect(toAccelerator(keyboard('AltLeft', 'Alt'), 'darwin')).toBeNull()
    expect(toAccelerator(keyboard('KeyE', 'Process', { isComposing: true }), 'darwin')).toBeNull()
    expect(toAccelerator(keyboard('F25', 'F25'), 'darwin')).toBeNull()
    expect(toAccelerator(keyboard('KeyA', 'a', { altKey: false }), 'win32')).toBeNull()
  })

  it('keeps Windows Alt shortcuts in Electron format', () => {
    expect(toAccelerator(keyboard('KeyA', 'a'), 'win32')).toBe('Alt+A')
    expect(toAccelerator(keyboard('Space', ' ', { shiftKey: true }), 'win32')).toBe('Alt+Shift+Space')
  })
})
