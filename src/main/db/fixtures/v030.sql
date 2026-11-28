-- 来自 v0.3.0（b6d8012c376de79ca210976db82a36e47376c039）真实 migrate() 创建的 SQLite 结构。
-- 仅结构，不含用户数据。
CREATE TABLE capture_habits (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    example      TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    used_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

CREATE TABLE courses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    teacher    TEXT NOT NULL DEFAULT '',
    meetings   TEXT NOT NULL,
    term_start TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

CREATE TABLE insights (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    evidence    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
    source_week TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

CREATE TABLE plan_blocks (
    id          TEXT PRIMARY KEY,
    task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    start_at    TEXT NOT NULL,
    end_at      TEXT NOT NULL,
    updated_at  TEXT NOT NULL, course_id TEXT REFERENCES courses(id) ON DELETE CASCADE, location TEXT NOT NULL DEFAULT '',
    CHECK (end_at > start_at)
  );

CREATE TABLE planner_habits (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    example      TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    used_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

CREATE TABLE reminder_dismissals (
    scope      TEXT NOT NULL CHECK (scope IN ('once', 'group')),
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, value)
  );

CREATE TABLE review_messages (
    id         TEXT PRIMARY KEY,
    week_start TEXT NOT NULL REFERENCES weekly_reviews(week_start) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
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
    updated_at    TEXT NOT NULL, target_end_at TEXT, planned_min INTEGER, extended_min INTEGER NOT NULL DEFAULT 0, overrun_reason TEXT
    CHECK (overrun_reason IS NULL OR overrun_reason IN ('estimate','scope','interrupted','record_error','unknown')),
    CHECK (end_at IS NULL OR end_at > start_at)
  );

CREATE TABLE weekly_reviews (
    week_start TEXT PRIMARY KEY,
    report     TEXT,
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_plan_blocks_course ON plan_blocks(course_id);

CREATE INDEX idx_plan_blocks_range ON plan_blocks(start_at, end_at);

CREATE INDEX idx_plan_blocks_task ON plan_blocks(task_id);

CREATE INDEX idx_review_messages_week ON review_messages(week_start, created_at);

CREATE INDEX idx_task_tags_tag ON task_tags(tag);

CREATE INDEX idx_tasks_review ON tasks(review_date);

CREATE INDEX idx_tasks_source ON tasks(source_task_id);

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_time_entries_range ON time_entries(start_at, end_at);

CREATE INDEX idx_time_entries_task ON time_entries(task_id);
PRAGMA user_version = 10;
