import { afterEach, expect, it, vi } from 'vitest'
import { isFullscreenAppActive } from './native'

const { createRequire } = vi.hoisted(() => ({ createRequire: vi.fn(() => { throw new Error('Windows module loader must not run') }) }))
vi.mock('node:module', async (importOriginal) => ({ ...await importOriginal<typeof import('node:module')>(), createRequire }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

it('does not try to load koffi or shell32 on darwin', () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  expect(isFullscreenAppActive()).toBeNull()
  expect(createRequire).not.toHaveBeenCalled()
})
