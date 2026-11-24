import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKGROUND_IMAGE_PREFIX, MAX_BACKGROUND_IMAGE_BYTES } from '@shared/background'
import type { Settings } from '@shared/types'
import { migrate } from './schema'
import { TimeRepo } from './timeRepo'

const blue = BACKGROUND_IMAGE_PREFIX + 'UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoCAAIAAUAmJaACdLoB+AH4AAPIAP7vUS/+yr4TI/9qv/7O5tVIf4KgAAA='
const red = BACKGROUND_IMAGE_PREFIX + 'UklGRjYAAABXRUJQVlA4ICoAAABwAQCdASoCAAIAAUAmJaACdAF1AAD+7/24Hxcv/7nA//2cD//ZwP4kAAA='

let db: DatabaseSync
let repo: TimeRepo

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new TimeRepo(db)
})
afterEach(() => db.close())

describe('背景设置', () => {
  it.each([7, 10])('从 M%i 升级时保留原来的主题和一天起点，默认没有壁纸', (version) => {
    repo.updateSettings({ theme: 'dark', dayStartHour: 7 })
    db.exec(`DROP TABLE background_image; PRAGMA user_version = ${version};`)
    migrate(db)
    expect(repo.getSettings()).toMatchObject({ theme: 'dark', dayStartHour: 7, backgroundMode: 'plain', backgroundFit: 'cover', backgroundOpacity: 60 })
    expect(repo.getBackgroundImage()).toBeNull()
  })

  it('图片可独立读取，切换主题或背景模式不丢失，且可显式清除', () => {
    repo.updateSettings({ backgroundMode: 'custom', backgroundFit: 'contain', theme: 'light' }, blue)
    const settings = repo.updateSettings({ theme: 'dark', backgroundMode: 'time' })
    expect(settings).toMatchObject({ theme: 'dark', backgroundMode: 'time', backgroundFit: 'contain' })
    expect(JSON.stringify(settings)).not.toContain('base64')
    expect(new TimeRepo(db).getBackgroundImage()).toBe(blue)
    expect(repo.updateSettings({ backgroundMode: 'custom' }).backgroundMode).toBe('custom')
    expect(() => repo.updateSettings({}, null)).toThrow(/先选择/)
    expect(repo.getBackgroundImage()).toBe(blue)
    expect(repo.updateSettings({ backgroundMode: 'plain' }, null).backgroundMode).toBe('plain')
    expect(repo.getBackgroundImage()).toBeNull()
  })

  it('拒绝无图的自定义模式和无效的背景选项', () => {
    expect(() => repo.updateSettings({ backgroundMode: 'custom' })).toThrow(/先选择/)
    expect(() => repo.updateSettings({ backgroundMode: 'bad' as Settings['backgroundMode'] })).toThrow(/背景模式/)
    expect(() => repo.updateSettings({ backgroundFit: 'bad' as Settings['backgroundFit'] })).toThrow(/适配方式/)
    expect(repo.getSettings().backgroundMode).toBe('plain')
  })

  it('原有图片默认显示为 60%，保存的 0% 和 100% 可重新读取', () => {
    expect(repo.updateSettings({ backgroundMode: 'custom' }, blue).backgroundOpacity).toBe(60)
    repo.updateSettings({ backgroundOpacity: 0 })
    expect(new TimeRepo(db).getSettings().backgroundOpacity).toBe(0)
    repo.updateSettings({ backgroundMode: 'time', theme: 'dark' })
    expect(repo.updateSettings({ backgroundMode: 'custom' }).backgroundOpacity).toBe(0)
    repo.updateSettings({ backgroundOpacity: 100 })
    expect(new TimeRepo(db).getSettings().backgroundOpacity).toBe(100)
    expect(repo.getBackgroundImage()).toBe(blue)
  })

  it('拒绝无效不透明度，并保留已保存的设置和图片', () => {
    repo.updateSettings({ backgroundMode: 'custom', backgroundOpacity: 72 }, blue)
    for (const value of [-1, 101, 50.5, NaN, '60', null]) {
      expect(() => repo.updateSettings({ backgroundOpacity: value as number, backgroundFit: 'contain' }, red)).toThrow(/不透明度/)
    }
    expect(repo.getSettings()).toMatchObject({ backgroundOpacity: 72, backgroundFit: 'cover' })
    expect(repo.getBackgroundImage()).toBe(blue)
  })

  it('无效图片不会覆盖之前的设置或图片', () => {
    repo.updateSettings({ backgroundMode: 'custom' }, blue)
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', BACKGROUND_IMAGE_PREFIX, blue + '!',
      BACKGROUND_IMAGE_PREFIX + 'A'.repeat(4 * Math.ceil(MAX_BACKGROUND_IMAGE_BYTES / 3) + 4)]) {
      expect(() => repo.updateSettings({ backgroundFit: 'contain' }, bad)).toThrow(/图片格式不对或文件过大/)
      expect(repo.getBackgroundImage()).toBe(blue)
      expect(repo.getSettings().backgroundFit).toBe('cover')
    }
  })

  it('设置写入失败时原图与其他设置一起回滚，之后可以重试', () => {
    repo.updateSettings({ backgroundMode: 'custom' }, blue)
    db.exec(`CREATE TRIGGER reject_fit BEFORE INSERT ON settings WHEN NEW.key = 'backgroundFit'
      BEGIN SELECT RAISE(ABORT, 'test abort'); END;`)
    expect(() => repo.updateSettings({ theme: 'light', backgroundFit: 'contain' }, red)).toThrow('test abort')
    expect(repo.getBackgroundImage()).toBe(blue)
    expect(repo.getSettings()).toMatchObject({ theme: 'system', backgroundFit: 'cover' })
    db.exec('DROP TRIGGER reject_fit')
    repo.updateSettings({ backgroundFit: 'contain' }, red)
    expect(repo.getBackgroundImage()).toBe(red)
  })
})
