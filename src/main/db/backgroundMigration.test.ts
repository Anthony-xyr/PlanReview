import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { TimeRepo } from './timeRepo'

// 真实 v0.3.0 migrate() 产出的结构，出处见 fixtures/v030.sql。
const v030 = readFileSync(new URL('./fixtures/v030.sql', import.meta.url), 'utf8')
const now = '2026-11-23T01:00:00.000Z'

function oldDatabase(version = 10) {
  const db = new DatabaseSync(':memory:')
  db.exec(v030)
  if (version === 9) db.exec('ALTER TABLE plan_blocks DROP COLUMN location')
  db.exec('PRAGMA user_version = ' + version)
  db.prepare('INSERT INTO categories (id,name,color,sort,archived,updated_at) VALUES (?,?,?,?,?,?)').run('c1','保留类别','#123456',3,0,now)
  db.prepare('INSERT INTO tasks (id,title,notes,status,category_id,estimate_min,next_step,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('t1','原有待办','原有备注','active','c1',60,'继续做',now,now)
  db.prepare('INSERT INTO task_tags VALUES (?,?)').run('t1','保留标签')
  db.prepare('INSERT INTO courses (id,name,location,teacher,meetings,term_start,updated_at) VALUES (?,?,?,?,?,?,?)').run('course1','原有课程','默认教室','老师',JSON.stringify([{ weekday:1,start:'09:00',end:'10:00',weeks:[1],location:'A101' }]),'2026-11-23',now)
  db.prepare('INSERT INTO plan_blocks (id,task_id,title,category_id,start_at,end_at,updated_at,course_id) VALUES (?,?,?,?,?,?,?,?)').run('b1','t1','保留计划','c1',new Date(2026,10,23,9).toISOString(),new Date(2026,10,23,10).toISOString(),now,'course1')
  if (version !== 9) db.prepare('UPDATE plan_blocks SET location = ? WHERE id = ?').run('用户改过的地点','b1')
  db.prepare('INSERT INTO time_entries (id,task_id,title,category_id,plan_block_id,start_at,end_at,source,note,updated_at,target_end_at,planned_min,extended_min,overrun_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('e1','t1','保留记录','c1','b1','2026-11-23T01:00:00.000Z','2026-11-23T02:05:00.000Z','timer','保留计时备注',now,'2026-11-23T02:00:00.000Z',60,5,'estimate')
  db.prepare('INSERT INTO settings VALUES (?,?)').run('theme',JSON.stringify('dark'))
  db.prepare('INSERT INTO settings VALUES (?,?)').run('dayStartHour',JSON.stringify(7))
  db.prepare('INSERT INTO daily_reviews VALUES (?,?,?,?,?,?)').run('2026-11-23',4,'原有日复盘','t1',now,now)
  db.prepare('INSERT INTO day_state VALUES (?,?,?)').run('2026-11-23','picks','["t1"]')
  db.prepare('INSERT INTO weekly_reviews VALUES (?,?,?,?,?)').run('2026-11-23','{"text":"原有周复盘"}','old-model',now,now)
  db.prepare('INSERT INTO review_messages VALUES (?,?,?,?,?)').run('m1','2026-11-23','user','原有追问',now)
  db.prepare('INSERT INTO insights VALUES (?,?,?,?,?,?,?)').run('i1','原有画像','原有证据','accepted','2026-11-23',now,now)
  for (const table of ['capture_habits','planner_habits']) db.prepare('INSERT INTO '+table+' VALUES (?,?,?,?,?,?,?,?)').run('h1','原有习惯','原有例子',1,3,now,now,now)
  db.prepare('INSERT INTO reminder_dismissals VALUES (?,?,?)').run('once','block-end:b1',now)
  return db
}

function rows(db: DatabaseSync, ignoreLocation = false) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'background_image' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(row => {
    const value = { ...row }
    if (ignoreLocation && name === 'plan_blocks') delete value.location
    return value
  })]))
}

function assertUpgrade(db: DatabaseSync, version: number) {
  const before = rows(db, version === 9)
  expect(Object.keys(before)).toHaveLength(15)
  migrate(db)
  expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(Math.max(version,11))
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='background_image'").get()).toBeDefined()
  expect(rows(db, version === 9)).toEqual(before)
  expect(new TimeRepo(db).getSettings()).toMatchObject({ theme:'dark',dayStartHour:7,backgroundMode:'plain',backgroundFit:'cover',backgroundOpacity:60 })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  const after = rows(db)
  migrate(db)
  expect(rows(db)).toEqual(after)
  expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(Math.max(version,11))
}

describe('主窗口背景的真实旧库迁移', () => {
  it('全新库顺序完成 M1–M11，重复启动不改变数据', () => {
    const db = new DatabaseSync(':memory:')
    try {
      migrate(db)
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(11)
      expect(db.prepare('SELECT COUNT(*) AS n FROM categories').get()!.n).toBe(5)
      expect(db.prepare('SELECT COUNT(*) AS n FROM background_image').get()!.n).toBe(0)
      const before=rows(db);migrate(db);expect(rows(db)).toEqual(before)
    } finally { db.close() }
  })
  it('v0.3.0 的 v10 库升级，15 张旧表逐行逐字段不变并保留用户地点', () => {
    const db = oldDatabase(10)
    try { assertUpgrade(db,10);expect(db.prepare('SELECT location FROM plan_blocks').get()!.location).toBe('用户改过的地点') } finally { db.close() }
  })
  it('v9 先补 M10 地点再做 M11，旧字段不丢且精确回填地点', () => {
    const db = oldDatabase(9)
    try { assertUpgrade(db,9);expect(db.prepare('SELECT location FROM plan_blocks').get()!.location).toBe('A101') } finally { db.close() }
  })
  it('更高版本但缺背景表也能补齐且绝不降低版本', () => {
    const db = oldDatabase(12)
    try { assertUpgrade(db,12) } finally { db.close() }
  })
})
