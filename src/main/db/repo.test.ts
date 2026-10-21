import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { Repo } from './repo'

let repo: Repo
let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  repo = new Repo(db)
})

describe('schema', () => {
  it('迁移可重复执行，并预置默认大类', () => {
    migrate(db)
    expect(repo.listCategories().map((c) => c.name)).toEqual(['学习', '课程作业', '项目', '生活', '娱乐'])
  })
})

describe('tasks', () => {
  it('快速收集只需一句话，默认进收件箱', () => {
    const t = repo.capture('  看完线代第三章  ')
    expect(t.title).toBe('看完线代第三章')
    expect(t.status).toBe('inbox')
    expect(t.estimateMin).toBeNull()
    expect(t.dueDate).toBeNull()
  })

  it('空内容拒绝', () => {
    expect(() => repo.capture('   ')).toThrow()
  })

  it('更新字段与标签，标签去重并去掉 #', () => {
    const t = repo.capture('写实验报告')
    const cat = repo.listCategories()[1]
    const u = repo.updateTask(t.id, { categoryId: cat.id, estimateMin: 180, tags: ['#物理', '物理', ' 实验 '] })
    expect(u.categoryId).toBe(cat.id)
    expect(u.estimateMin).toBe(180)
    expect(u.tags).toEqual(['实验', '物理'])
    expect(repo.listTags()).toEqual(['实验', '物理'])
  })

  it('完成与重新打开会维护完成时间', () => {
    const t = repo.capture('a')
    const done = repo.updateTask(t.id, { status: 'done' })
    expect(done.completedAt).not.toBeNull()
    const reopened = repo.updateTask(t.id, { status: 'active' })
    expect(reopened.completedAt).toBeNull()
  })

  it('按状态、标签、关键词筛选', () => {
    const a = repo.createTask({ title: '复习高数', status: 'active', tags: ['考试'] })
    repo.createTask({ title: '买牙膏', status: 'inbox' })
    repo.createTask({ title: '100%_完成', status: 'inbox' })
    expect(repo.listTasks({ status: 'active' }).map((t) => t.id)).toEqual([a.id])
    expect(repo.listTasks({ tag: '考试' }).map((t) => t.id)).toEqual([a.id])
    expect(repo.listTasks({ search: '牙膏' })).toHaveLength(1)
    expect(repo.listTasks({ search: '%_' })).toHaveLength(1)
    expect(repo.listTasks({ status: ['inbox', 'active'] })).toHaveLength(3)
  })

  it('删除任务时延伸任务保留，来源置空', () => {
    const a = repo.capture('a')
    const b = repo.spinOff(a.id, { title: 'b' })
    repo.deleteTask(a.id)
    expect(repo.getTask(b.id)?.sourceTaskId).toBeNull()
  })
})

describe('spin-off & lineage', () => {
  it('延伸任务继承大类和标签并记录来源', () => {
    const cat = repo.listCategories()[0]
    const a = repo.createTask({ title: '读论文', categoryId: cat.id, tags: ['科研'] })
    const b = repo.spinOff(a.id, { title: '复现论文里的实验' })
    expect(b.sourceTaskId).toBe(a.id)
    expect(b.categoryId).toBe(cat.id)
    expect(b.tags).toEqual(['科研'])
  })

  it('来源链从任意节点都能取到整条链', () => {
    const a = repo.capture('a')
    const b = repo.spinOff(a.id, { title: 'b' })
    const c = repo.spinOff(b.id, { title: 'c' })
    const d = repo.spinOff(a.id, { title: 'd' })
    repo.capture('无关')
    const ids = (id: string) => repo.lineage(id).map((t) => t.id).sort()
    const all = [a.id, b.id, c.id, d.id].sort()
    expect(ids(c.id)).toEqual(all)
    expect(ids(a.id)).toEqual(all)
  })

  it('来源不能形成循环', () => {
    const a = repo.capture('a')
    const b = repo.spinOff(a.id, { title: 'b' })
    expect(() => repo.updateTask(a.id, { sourceTaskId: b.id })).toThrow()
    expect(() => repo.updateTask(a.id, { sourceTaskId: a.id })).toThrow()
  })
})

describe('categories', () => {
  it('新建、改名、归档', () => {
    const c = repo.createCategory('  社团 ', '#000000')
    expect(c.name).toBe('社团')
    expect(c.sort).toBe(5)
    const u = repo.updateCategory(c.id, { name: '学生会', archived: true })
    expect(u.name).toBe('学生会')
    expect(u.archived).toBe(true)
  })
})
