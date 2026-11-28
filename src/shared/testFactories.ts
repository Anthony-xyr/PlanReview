// Shared test data factories with sensible defaults so extending core entity
// fields does not require touching unrelated test files.

import type { CaptureDraft, Category, PlanBlock, Task, TimeEntry, WeekDay, WeekStats } from './types'

const DEFAULT_TS = '2026-10-16T00:00:00.000Z'
const DEFAULT_START = '2026-10-16T01:00:00.000Z'
const DEFAULT_END = '2026-10-16T02:00:00.000Z'

export function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    name: '学习',
    color: '#3b82f6',
    sort: 0,
    archived: false,
    ...overrides
  }
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '测试任务',
    notes: '',
    status: 'active',
    categoryId: null,
    tags: [],
    estimateMin: null,
    nextStep: '',
    sourceTaskId: null,
    dueDate: null,
    reviewDate: null,
    createdAt: DEFAULT_TS,
    updatedAt: DEFAULT_TS,
    completedAt: null,
    spentMin: 0,
    ...overrides
  }
}

export function makePlanBlock(overrides: Partial<PlanBlock> = {}): PlanBlock {
  return {
    id: 'block-1',
    taskId: null,
    title: '计划时段',
    categoryId: null,
    taskStatus: null,
    startAt: DEFAULT_START,
    endAt: DEFAULT_END,
    courseId: null,
    location: '',
    ...overrides
  }
}

export function makeTimeEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 'entry-1',
    taskId: null,
    title: '计时记录',
    categoryId: null,
    planBlockId: null,
    startAt: DEFAULT_START,
    endAt: null,
    source: 'timer',
    note: '',
    targetEndAt: null,
    plannedMin: null,
    extendedMin: 0,
    overrunReason: null,
    ...overrides
  }
}

export function makeCaptureDraft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    title: '测试速记',
    categoryId: null,
    tags: [],
    estimateMin: null,
    dueDate: null,
    reviewDate: null,
    notes: '',
    ...overrides
  }
}

export function makeWeekDay(overrides: Partial<WeekDay> = {}): WeekDay {
  return {
    day: '2026-10-12',
    plannedMin: 0,
    actualMin: 0,
    byCategory: {},
    sleepWindowMin: 0,
    lastEndAt: null,
    mood: null,
    ...overrides
  }
}

export function makeWeekStats(overrides: Partial<WeekStats> = {}): WeekStats {
  return {
    weekStart: '2026-10-12',
    days: Array.from({ length: 7 }, (_, i) => makeWeekDay({ day: `2026-10-${12 + i}` })),
    plannedMin: 0,
    actualMin: 0,
    fulfilment: null,
    byCategory: [],
    estimates: [],
    reasons: [],
    completed: 0,
    created: 0,
    spinOffs: 0,
    reviewedDays: 0,
    ...overrides
  }
}
