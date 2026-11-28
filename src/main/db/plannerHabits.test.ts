import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_HABITS, MAX_HABIT_CHARS, type HabitKind } from '@shared/types'
import { HabitRepo } from './habitRepo'
import { migrate } from './schema'

// 用单元素元组包住数组输入，避免参数化测试把畸形数组展开成多个参数。
const cases = (values: unknown[]) => values.map((value) => [value] as const)

let db: DatabaseSync
const now = () => new Date('2026-11-04T09:00:00.000Z')
beforeEach(() => { db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => db.close())

for (const kind of ['capture', 'planner'] as const) describe(kind + ' 习惯仓储', () => {
  const make = () => new HabitRepo(db, kind, now)
  it('完整增查改写启停计次删除，另一张表保持空', () => {
    const repo = make()
    const other = new HabitRepo(db, kind === 'capture' ? 'planner' : 'capture')
    const h = repo.add('  先阅读   再复现  ', '例子')
    expect(h).toMatchObject({ text: '先阅读 再复现', enabled: true, usedCount: 0, example: '例子' })
    expect(repo.get(h.id)).toEqual(h)
    expect(repo.enabled()).toEqual([h])
    repo.markUsed([h.id, h.id, 'unknown'])
    expect(repo.get(h.id)).toMatchObject({ usedCount: 1, lastUsedAt: now().toISOString() })
    repo.update(h.id, { enabled: false })
    expect(repo.enabled()).toEqual([])
    expect(repo.add('先阅读 再复现').id).toBe(h.id)
    expect(repo.get(h.id)!.enabled).toBe(true)
    const replaced = repo.add('先做实验', '纠正', h.id)
    expect(replaced).toMatchObject({ id: h.id, text: '先做实验', usedCount: 1, example: '纠正' })
    repo.update(h.id, { text: '新文本', enabled: false })
    expect(repo.get(h.id)).toMatchObject({ text: '新文本', enabled: false })
    expect(other.list()).toEqual([])
    repo.remove(h.id)
    repo.remove('unknown')
    expect(repo.get(h.id)).toBeNull()
    expect(repo.list()).toEqual([])
  })
  it('每类独立遵守数量上限，重复或改写不新增', () => {
    const repo = make()
    for (let i = 0; i < MAX_HABITS; i++) repo.add('规则' + i)
    expect(() => repo.add('超限')).toThrow('最多记 ' + MAX_HABITS)
    expect(repo.list()).toHaveLength(MAX_HABITS)
    expect(repo.add('规则0')).toBeDefined()
    expect(repo.add('改写', '', repo.list()[0].id)).toBeDefined()
    new HabitRepo(db, kind === 'capture' ? 'planner' : 'capture').add('另一类不受影响')
  })
  it('沿用文字长度和空白校验', () => {
    const repo = make()
    expect(() => repo.add('  ')).toThrow('习惯不能为空')
    expect(() => repo.add('字'.repeat(MAX_HABIT_CHARS + 1))).toThrow('一条习惯最多')
    const h = repo.add('字'.repeat(MAX_HABIT_CHARS))
    expect(() => repo.update(h.id, { text: '' })).toThrow('习惯不能为空')
    expect(() => repo.update(h.id, { text: '字'.repeat(MAX_HABIT_CHARS + 1) })).toThrow('一条习惯最多')
    expect(() => repo.update('unknown', {})).toThrow('这条习惯不存在')
  })
})

it('省略 kind 与 capture 完全一致，旧 (db, now) 构造签名保留', () => {
  const implicit = new HabitRepo(db, now)
  const explicit = new HabitRepo(db, 'capture', now)
  const h = implicit.add('原有速记规则')
  expect(implicit.list()).toEqual(explicit.list())
  expect(h.createdAt).toBe(now().toISOString())
  explicit.update(h.id, { enabled: false })
  expect(implicit.enabled()).toEqual(explicit.enabled())
})

it.each(cases([undefined, null, '', 'unknown', '__proto__', 'constructor', 'toString', 123, {}, [], Object.create({ planner: 'planner' }), 'planner_habits; DROP TABLE capture_habits']))('非法 kind %j 安全降级为 capture', (kind) => {
  const repo = new HabitRepo(db, kind as HabitKind, now)
  const h = repo.add('默认速记')
  expect(new HabitRepo(db).list()).toEqual([h])
  expect(new HabitRepo(db, 'planner').list()).toEqual([])
})

it('不能借另一表的 id 更新、删除、计次或替换那张表的记录', () => {
  const capture = new HabitRepo(db)
  const planner = new HabitRepo(db, 'planner')
  const c = capture.add('速记')
  const p = planner.add('排程')
  expect(() => planner.update(c.id, { text: '越界' })).toThrow('不存在')
  planner.remove(c.id); planner.markUsed([c.id])
  capture.remove(p.id); capture.markUsed([p.id])
  expect(capture.get(c.id)).toEqual(c)
  expect(planner.get(p.id)).toEqual(p)
  expect(planner.add('独立新增', '', c.id).id).not.toBe(c.id)
  expect(capture.get(c.id)).toEqual(c)
})

const v030 = readFileSync(new URL('./fixtures/v030.sql', import.meta.url), 'utf8')
it('v0.3.0 的既有 planner_habits 数据升级后完整保留', () => {
  const old = new DatabaseSync(':memory:')
  try {
    old.exec(v030 + '; PRAGMA user_version = 10;')
    const c = new HabitRepo(old).add('已有速记')
    const p = new HabitRepo(old, 'planner').add('已有排程')
    migrate(old); migrate(old)
    expect(new HabitRepo(old).get(c.id)).toEqual(c)
    expect(new HabitRepo(old, 'planner').get(p.id)).toEqual(p)
    expect(old.prepare('PRAGMA user_version').get()!.user_version).toBe(11)
    expect(old.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  } finally { old.close() }
})
it.each(cases([8, 11]))('旧库 v%i 缺少排程表时由已有迁移修复，速记不受影响', (version) => {
  const old = new DatabaseSync(':memory:')
  try {
    old.exec(v030 + '; DROP TABLE planner_habits; PRAGMA user_version = ' + version)
    const c = new HabitRepo(old).add('保留速记')
    migrate(old)
    expect(new HabitRepo(old).list()).toEqual([c])
    expect(new HabitRepo(old, 'planner').list()).toEqual([])
    expect(old.prepare('PRAGMA user_version').get()!.user_version).toBe(11)
    migrate(old)
    expect(new HabitRepo(old).list()).toEqual([c])
  } finally { old.close() }
})
