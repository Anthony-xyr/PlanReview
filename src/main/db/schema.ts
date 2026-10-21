import type { DatabaseSync } from 'node:sqlite'

// 按顺序执行的迁移；PRAGMA user_version 记录已执行到第几条。
// 主键用 UUID、每行带 updated_at，方便以后做多端同步。
const migrations: string[] = [
  `
  CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'inbox'
                   CHECK (status IN ('inbox','active','done','dropped')),
    category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
    estimate_min   INTEGER CHECK (estimate_min IS NULL OR estimate_min >= 0),
    next_step      TEXT NOT NULL DEFAULT '',
    source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    due_date       TEXT,
    review_date    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    completed_at   TEXT
  );
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE INDEX idx_tasks_source ON tasks(source_task_id);

  CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
  );
  CREATE INDEX idx_task_tags_tag ON task_tags(tag);
  `,
  // M2：计划时段、实际记录、设置。关联任务时 title 留空、显示任务标题；任务被删时把标题写回 title 保留历史
  `
  CREATE TABLE plan_blocks (
    id          TEXT PRIMARY KEY,
    task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    start_at    TEXT NOT NULL,
    end_at      TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK (end_at > start_at)
  );
  CREATE INDEX idx_plan_blocks_range ON plan_blocks(start_at, end_at);
  CREATE INDEX idx_plan_blocks_task ON plan_blocks(task_id);

  CREATE TABLE time_entries (
    id            TEXT PRIMARY KEY,
    task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title         TEXT NOT NULL DEFAULT '',
    category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
    plan_block_id TEXT REFERENCES plan_blocks(id) ON DELETE SET NULL,
    start_at      TEXT NOT NULL,
    end_at        TEXT,
    source        TEXT NOT NULL CHECK (source IN ('timer','manual')),
    note          TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL,
    CHECK (end_at IS NULL OR end_at > start_at)
  );
  CREATE INDEX idx_time_entries_range ON time_entries(start_at, end_at);
  CREATE INDEX idx_time_entries_task ON time_entries(task_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // M3：本次投入的目标时长、延长、超时原因
  `
  ALTER TABLE time_entries ADD COLUMN target_end_at TEXT;
  ALTER TABLE time_entries ADD COLUMN planned_min INTEGER;
  ALTER TABLE time_entries ADD COLUMN extended_min INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE time_entries ADD COLUMN overrun_reason TEXT
    CHECK (overrun_reason IS NULL OR overrun_reason IN ('estimate','scope','interrupted','record_error','unknown'));
  `,
  // M4：课表。课程的每次上课生成为计划时段（course_id 关联），删课表时一起删掉
  `
  CREATE TABLE courses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    teacher    TEXT NOT NULL DEFAULT '',
    meetings   TEXT NOT NULL,
    term_start TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE plan_blocks ADD COLUMN course_id TEXT REFERENCES courses(id) ON DELETE CASCADE;
  CREATE INDEX idx_plan_blocks_course ON plan_blocks(course_id);
  `,
  // M5：每日复盘；每天的随机推送和「已整理」状态记在 day_state 里，同一天内保持不变
  `
  CREATE TABLE daily_reviews (
    day              TEXT PRIMARY KEY,
    mood             INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
    note             TEXT NOT NULL DEFAULT '',
    tomorrow_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE day_state (
    day   TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (day, key)
  );
  CREATE INDEX idx_tasks_review ON tasks(review_date);
  `,
  // M6：周复盘与 AI。旧默认色里蓝和紫几乎分不清，只替换仍是旧默认值的颜色，用户改过的不动
  `
  UPDATE categories SET color = '#2a78d6' WHERE color = '#4f7cff';
  UPDATE categories SET color = '#eb6834' WHERE color = '#8b5cf6';
  UPDATE categories SET color = '#1baf7a' WHERE color = '#0ea5a4';
  UPDATE categories SET color = '#eda100' WHERE color = '#f59e0b';
  UPDATE categories SET color = '#e87ba4' WHERE color = '#ec4899';
  UPDATE categories SET color = '#4a3aa7' WHERE color = '#64748b';

  CREATE TABLE weekly_reviews (
    week_start TEXT PRIMARY KEY,
    report     TEXT,
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE review_messages (
    id         TEXT PRIMARY KEY,
    week_start TEXT NOT NULL REFERENCES weekly_reviews(week_start) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_review_messages_week ON review_messages(week_start, created_at);

  CREATE TABLE insights (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    evidence    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
    source_week TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `
]

// 默认大类颜色：按固定顺序取自经过色盲校验的分类色板（相邻两色在各类色觉下都能分清）
export const CATEGORY_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#008300', '#e34948']

const defaultCategories: [string, string][] = [
  ['学习', CATEGORY_PALETTE[0]],
  ['课程作业', CATEGORY_PALETTE[1]],
  ['项目', CATEGORY_PALETTE[2]],
  ['生活', CATEGORY_PALETTE[3]],
  ['娱乐', CATEGORY_PALETTE[4]]
]

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }

  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(migrations[v])
      if (v === 0) seedCategories(db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

function seedCategories(db: DatabaseSync): void {
  const now = new Date().toISOString()
  const insert = db.prepare('INSERT INTO categories (id, name, color, sort, updated_at) VALUES (?, ?, ?, ?, ?)')
  defaultCategories.forEach(([name, color], i) => insert.run(crypto.randomUUID(), name, color, i, now))
}
