// 主进程与界面共用的数据类型。时间一律存 ISO 字符串（UTC），日期存 'YYYY-MM-DD'（本地日期）。

export type TaskStatus = 'inbox' | 'active' | 'done' | 'dropped'

export interface Category {
  id: string
  name: string
  color: string
  sort: number
  archived: boolean
}

export interface Task {
  id: string
  title: string
  notes: string
  status: TaskStatus
  categoryId: string | null
  tags: string[]
  /** 总估时（分钟），可空：快速收集时不必填写 */
  estimateMin: number | null
  /** 下一步：结束本次投入时留给下次的自己 */
  nextStep: string
  /** 延伸来源：从哪个任务拆出来的 */
  sourceTaskId: string | null
  /** 截止日期，可空；无截止事项不必虚构日期 */
  dueDate: string | null
  /** 下次查看日：到这天后出现在今日待定区 */
  reviewDate: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** 已投入（分钟），由实际记录汇总，进行中的计时算到此刻 */
  spentMin: number
}

/** 计划时段：关联任务，或是不关联任务的保留时段（如娱乐） */
export interface PlanBlock {
  id: string
  taskId: string | null
  /** 关联任务时为任务标题 */
  title: string
  categoryId: string | null
  taskStatus: TaskStatus | null
  startAt: string
  endAt: string
  /** 由课表生成的上课时段 */
  courseId: string | null
  location: string
}

export type EntrySource = 'timer' | 'manual'

/** 实际记录：计时或补录产生，与计划分开保存 */
export interface TimeEntry {
  id: string
  taskId: string | null
  title: string
  categoryId: string | null
  planBlockId: string | null
  startAt: string
  /** null 表示正在计时 */
  endAt: string | null
  source: EntrySource
  note: string
  /** 本次计划到几点结束；延长会推后它，但不改原计划 */
  targetEndAt: string | null
  /** 开始时定下的本次时长（分钟），用于判断超时 */
  plannedMin: number | null
  /** 累计延长了多少分钟 */
  extendedMin: number
  overrunReason: OverrunReason | null
}

export type OverrunReason = 'estimate' | 'scope' | 'interrupted' | 'record_error' | 'unknown'

export const OVERRUN_REASONS: { value: OverrunReason; label: string; hint: string }[] = [
  { value: 'estimate', label: '估时偏差', hint: '这件事本来就需要更久' },
  { value: 'scope', label: '范围扩大', hint: '做着做着多出了内容' },
  { value: 'interrupted', label: '受干扰', hint: '被打断或环境不好' },
  { value: 'record_error', label: '记录有误', hint: '忘了停表之类' },
  { value: 'unknown', label: '说不清', hint: '' }
]

export interface BlockInput {
  taskId?: string | null
  title?: string
  categoryId?: string | null
  startAt: string
  endAt: string
  location?: string
}

export interface EntryInput extends BlockInput {
  note?: string
}

export interface StartTimerInput {
  taskId?: string | null
  title?: string
  categoryId?: string | null
  planBlockId?: string | null
  /** 本次时长；不填时用计划块的结束时间或默认时长 */
  durationMin?: number | null
}

export interface StopTimerInput {
  nextStep?: string
  complete?: boolean
  overrunReason?: OverrunReason | null
}

export interface StopResult {
  entry: TimeEntry | null
  /** 不足 1 分钟的计时不保存 */
  discarded: boolean
}

export interface Settings {
  /** 一天从几点算起，之前的时间归前一天 */
  dayStartHour: number
  /** 睡眠窗口，'HH:MM' */
  sleepStart: string
  sleepEnd: string
  /** 从任务直接开始计时时的默认本次时长；null 表示不设 */
  defaultSessionMin: number | null
  extendStepMin: number
  /** 实际超过本次计划多少比例时询问原因 */
  overrunAskRatio: number
  /** 睡眠窗口前多少分钟开始强提醒 */
  sleepLeadMin: number
  leaveEnabled: boolean
  /** 自习室离开时间 */
  leaveTime: string
  leaveLeadMin: number
  /** 计划块开始 / 保留时段结束时提醒 */
  blockReminders: boolean
  /** 强提醒时播放提示音 */
  strongSound: boolean
  floatingEnabled: boolean
  hideInFullscreen: boolean
  hotkey: string
  closeToTray: boolean
  launchAtLogin: boolean
  /** 每日随机推送几条未排期事项，0 表示关闭 */
  dailyPicks: number
  /** 收件箱积压到多少条、或最旧一条放了多少天，提示整理 */
  inboxNagCount: number
  inboxNagDays: number
  /** 每周哪天提醒整理（0=周日 … 6=周六） */
  weeklyReviewDay: number
  /** 外观：跟随系统、浅色、深色 */
  theme: ThemeMode
}

export type ThemeMode = 'system' | 'light' | 'dark'

// ---------- 找回 ----------

/** 今天该回头看的事：到了下次查看日的、随机抽到的、收件箱积压情况 */
export interface Resurface {
  /** 下次查看日已到（含已过） */
  due: Task[]
  /** 今天随机抽到的未排期事项，同一天内固定 */
  picks: Task[]
  inbox: { count: number; oldestDays: number }
  /** 是否该提示整理：积压过多，或今天是每周整理日且收件箱不空 */
  tidyNeeded: boolean
  /** 今天已经整理过（关掉了提示） */
  tidyDismissed: boolean
  /** 昨天复盘时选的「今天先做」，已完成则为 null */
  firstThing: Task | null
  /** 昨天有计划或记录但还没复盘 */
  yesterdayUnreviewed: boolean
}

/** 找回卡片上的处理方式 */
export type ResurfaceAction =
  | { kind: 'keep' } // 移到待办
  | { kind: 'later'; days: number } // 改到几天后再看
  | { kind: 'clear' } // 去掉下次查看日，不再提醒
  | { kind: 'drop' } // 不做了

// ---------- 每日复盘 ----------

export type DayMood = 1 | 2 | 3 | 4 | 5

export interface DailyReview {
  /** 复盘的是哪一天（按一天的起点算） */
  day: string
  /** 整体感觉 1–5 */
  mood: DayMood | null
  /** 做得好的 / 想调整的，一两句 */
  note: string
  /** 明天最想先做的一件事 */
  tomorrowTaskId: string | null
  createdAt: string
  updatedAt: string
}

export interface DailyReviewInput {
  mood?: DayMood | null
  note?: string
  tomorrowTaskId?: string | null
}

/** 复盘页需要的当天数据，由主进程一次算好 */
export interface DaySummary {
  day: string
  plannedMin: number
  actualMin: number
  /** 按大类：计划 vs 实际 */
  byCategory: { categoryId: string | null; plannedMin: number; actualMin: number }[]
  /** 计划过但完全没动的块 */
  skipped: PlanBlock[]
  /** 没有计划、临时插入的实际记录 */
  unplanned: TimeEntry[]
  /** 超时但还没标原因的记录；plannedMin 是本次原定时长，补录的记录取对应计划块的长度 */
  needReason: { entry: TimeEntry; plannedMin: number }[]
  /** 今天完成的任务 */
  completed: Task[]
  review: DailyReview | null
}

// ---------- AI ----------

/** OpenAI 兼容接口配置；界面拿不到明文 Key */
export interface AiConfigView {
  enabled: boolean
  baseUrl: string
  model: string
  /** 识图用的模型，空表示和 model 相同 */
  visionModel: string
  hasKey: boolean
  /** Key 是否用系统加密保存 */
  keyEncrypted: boolean
  /** 速记时自动解析 */
  parseCapture: boolean
  /** 各项 AI 任务的推理强度 */
  reasoningEffort: Record<AiTask, ReasoningEffort>
}

/** 推理强度，对应 OpenAI 兼容接口的 reasoning_effort */
export type ReasoningEffort = 'low' | 'medium' | 'high'
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']

/** 用到 AI 的场景 */
export type AiTask = 'capture' | 'schedule' | 'planner' | 'weeklyReview' | 'weeklyQA'

export type AiConfigPatch = Partial<Omit<AiConfigView, 'hasKey' | 'keyEncrypted' | 'reasoningEffort'>> & {
  apiKey?: string
  reasoningEffort?: Partial<Record<AiTask, ReasoningEffort>>
}

/** AI 从一句速记里拆出来的字段，确认后才写入 */
export interface CaptureDraft {
  title: string
  categoryId: string | null
  tags: string[]
  estimateMin: number | null
  dueDate: string | null
  reviewDate: string | null
  notes: string
}

/** 速记解析的结果；habitIds 是这次 AI 说用到的习惯 */
export interface CaptureParse {
  draft: CaptureDraft
  habitIds: string[]
}

/** 用户纠正后重新解析：新结果 + AI 概括出的一条习惯（确认保存时才记下） */
export interface CaptureReparse extends CaptureParse {
  /** 空字符串表示这次纠正不值得记成习惯 */
  habit: string
  /** 这条新习惯会替换掉的旧习惯 */
  replacesId: string | null
}

/** 用户的速记习惯：AI 解析速记时参考，用户确认后才会记下 */
export interface CaptureHabit {
  id: string
  text: string
  /** 记下这条习惯时的那句速记 */
  example: string
  enabled: boolean
  /** AI 报告用到它的次数 */
  usedCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export const MAX_HABITS = 30
export const MAX_HABIT_CHARS = 120

/** 课表导入时上传的文件，已在界面里读成文本或图片 */
export interface ImportFile {
  name: string
  kind: 'text' | 'image'
  /** 文本内容，或图片的 data URL */
  content: string
}

/** 一门课每周的一次上课 */
export interface CourseMeeting {
  /** 1=周一 … 7=周日 */
  weekday: number
  start: string
  end: string
  /** 第几周上课，如 [1,2,…,16] */
  weeks: number[]
  location: string
}

export interface ScheduleDraft {
  /** 第一周的周一，'YYYY-MM-DD' */
  termStart: string
  courses: { name: string; teacher: string; location: string; meetings: CourseMeeting[] }[]
  /** 解析时的说明 / 无法确定的地方 */
  notes: string[]
}

export interface Course {
  id: string
  name: string
  location: string
  teacher: string
  meetings: CourseMeeting[]
}

export type ReminderKind = 'session-end' | 'sleep-lead' | 'sleep' | 'leave' | 'block-start' | 'block-end'

/** 延长或继续下去会影响什么 */
export interface Impact {
  /** 会被挤占的后续计划 */
  squeezed: { title: string; startAt: string }[]
  /** 距离睡眠窗口还有多少分钟；已进入时为 0 */
  minutesToSleep: number
  /** 现在之后、睡眠窗口之前还没做的计划分钟数 */
  remainingPlannedMin: number
}

export interface Reminder {
  id: string
  kind: ReminderKind
  strong: boolean
  title: string
  body: string
  entryId?: string
  blockId?: string
  taskId?: string | null
  impact?: Impact
  /** 延长时会用到的步长 */
  extendMin?: number
  /** 第一次出现（用于决定是否响铃） */
  fresh: boolean
}

export type MainCommand = 'stop' | 'wrap-up' | 'today' | 'review' | 'weekly'

// ---------- 周复盘 ----------

export interface WeekDay {
  day: string
  plannedMin: number
  actualMin: number
  /** 按大类的实际分钟数 */
  byCategory: Record<string, number>
  /** 落在睡眠窗口里的实际分钟数 */
  sleepWindowMin: number
  /** 当天最后一条记录结束的时刻（ISO），没有记录为 null */
  lastEndAt: string | null
  mood: DayMood | null
}

export interface WeekCategory {
  categoryId: string | null
  plannedMin: number
  actualMin: number
}

/** 估时偏差：本周完成的、有估时的任务，实际 / 估时 */
export interface EstimateRow {
  taskId: string
  title: string
  categoryId: string | null
  estimateMin: number
  spentMin: number
}

export interface WeekStats {
  weekStart: string
  days: WeekDay[]
  plannedMin: number
  actualMin: number
  /** 计划块里实际做了的比例（按分钟，0–1；没计划为 null） */
  fulfilment: number | null
  byCategory: WeekCategory[]
  estimates: EstimateRow[]
  /** 超时原因计数，含「未标注」 */
  reasons: { reason: OverrunReason | 'none'; count: number; minutes: number }[]
  /** 本周完成的任务数 / 新建的任务数 */
  completed: number
  created: number
  /** 范围扩大拆出的延伸任务数 */
  spinOffs: number
  /** 写了每日复盘的天数 */
  reviewedDays: number
}

/** 建议附带的改动；采纳后才执行 */
export type SuggestionAction =
  | { kind: 'none' }
  | { kind: 'setting'; key: 'defaultSessionMin' | 'extendStepMin' | 'leaveTime' | 'sleepStart' | 'sleepLeadMin'; value: number | string }
  | { kind: 'estimate'; taskId: string; estimateMin: number }
  | { kind: 'insight'; text: string }

export interface Suggestion {
  id: string
  title: string
  /** 依据：引用本周的具体数字或记录 */
  evidence: string
  action: SuggestionAction
  status: 'open' | 'applied' | 'dismissed'
}

export interface WeeklyReport {
  summary: string
  /** 做得好的 */
  wins: string[]
  /** 观察到的规律 */
  patterns: string[]
  suggestions: Suggestion[]
}

export interface ReviewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface WeeklyReview {
  weekStart: string
  report: WeeklyReport | null
  model: string
  messages: ReviewMessage[]
  createdAt: string
  updatedAt: string
}

// ---------- 个人画像 ----------

export type InsightStatus = 'pending' | 'accepted' | 'rejected'

/** AI 总结出的个人规律，确认后才会在之后的复盘里被引用 */
export interface Insight {
  id: string
  text: string
  evidence: string
  status: InsightStatus
  sourceWeek: string | null
  createdAt: string
  updatedAt: string
}

// ---------- AI 排程 ----------

export interface SuggestedBlock {
  taskId: string | null
  title: string
  startAt: string
  endAt: string
  /** 为什么排在这里 */
  reason: string
}

export interface PlanSuggestion {
  day: string
  blocks: SuggestedBlock[]
  notes: string[]
}

export interface SystemStatus {
  hotkeyRegistered: boolean
  fullscreenDetection: boolean
}

export interface TaskInput {
  title?: string
  notes?: string
  status?: TaskStatus
  categoryId?: string | null
  tags?: string[]
  estimateMin?: number | null
  nextStep?: string
  sourceTaskId?: string | null
  dueDate?: string | null
  reviewDate?: string | null
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  /** null 表示未分类 */
  categoryId?: string | null
  tag?: string
  search?: string
}

/** 预加载脚本暴露给界面的接口 */
export interface Api {
  tasks: {
    list(filter?: TaskFilter): Promise<Task[]>
    get(id: string): Promise<Task | null>
    /** 速记；defaults 来自当前页面（如在某大类页面里记，就归到该大类） */
    capture(text: string, defaults?: TaskInput): Promise<Task>
    create(input: TaskInput): Promise<Task>
    update(id: string, patch: TaskInput): Promise<Task>
    remove(id: string): Promise<void>
    /** 拆出延伸任务：新任务记录来源 */
    spinOff(sourceId: string, input: TaskInput): Promise<Task>
    /** 来源链：此任务的祖先与所有后代 */
    lineage(id: string): Promise<Task[]>
  }
  categories: {
    list(): Promise<Category[]>
    create(name: string, color: string): Promise<Category>
    update(id: string, patch: Partial<Pick<Category, 'name' | 'color' | 'sort' | 'archived'>>): Promise<Category>
    /** 删除（归档），旧任务保留它。moveOpenTo：没结束的任务改到这个类别，null 为未分类，不给则不改 */
    remove(id: string, moveOpenTo?: string | null): Promise<Category>
    /** 按给定顺序重排 */
    reorder(ids: string[]): Promise<void>
    /** 每个类别没结束的任务数，未分类的键为 '' */
    openCounts(): Promise<Record<string, number>>
  }
  tags: {
    list(): Promise<string[]>
  }
  plan: {
    /** 与 [from, to) 有重叠的计划时段 */
    list(from: string, to: string): Promise<PlanBlock[]>
    create(input: BlockInput): Promise<PlanBlock>
    update(id: string, patch: Partial<BlockInput>): Promise<PlanBlock>
    remove(id: string): Promise<void>
  }
  entries: {
    list(from: string, to: string): Promise<TimeEntry[]>
    create(input: EntryInput): Promise<TimeEntry>
    update(id: string, patch: Partial<EntryInput>): Promise<TimeEntry>
    remove(id: string): Promise<void>
    running(): Promise<TimeEntry | null>
    start(input: StartTimerInput): Promise<TimeEntry>
    stop(input: StopTimerInput): Promise<StopResult>
    /** 延长本次投入（不改原计划） */
    extend(min: number): Promise<TimeEntry>
    setTarget(endAt: string | null): Promise<TimeEntry>
    setReason(id: string, reason: OverrunReason | null): Promise<TimeEntry>
  }
  reminders: {
    current(): Promise<Reminder | null>
    /** group：同类提醒今天不再出现（如「今晚不再提醒」） */
    dismiss(id: string, scope?: 'once' | 'group'): Promise<void>
    snooze(id: string, min: number): Promise<void>
    onChange(cb: (r: Reminder | null) => void): () => void
  }
  events: {
    onDataChanged(cb: () => void): () => void
    /** 主窗口：被要求打开某个流程 */
    onCommand(cb: (cmd: MainCommand) => void): () => void
  }
  win: {
    openMain(cmd?: MainCommand): Promise<void>
    showFloat(): Promise<void>
    hideFloat(): Promise<void>
    resizeFloat(height: number): Promise<void>
    status(): Promise<SystemStatus>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  ai: {
    getConfig(): Promise<AiConfigView>
    /** apiKey：undefined 不改，'' 清除 */
    setConfig(patch: AiConfigPatch): Promise<AiConfigView>
    test(): Promise<{ ok: true; model: string; ms: number }>
    parseCapture(text: string): Promise<CaptureParse>
    /** 纠正后重新解析；feedback 是这句速记历次的纠正说明，最新的在最后 */
    reparseCapture(text: string, previous: CaptureDraft, feedback: string[]): Promise<CaptureReparse>
    parseSchedule(files: ImportFile[], hint: string): Promise<ScheduleDraft>
  }
  habits: {
    list(): Promise<CaptureHabit[]>
    /** 记下一条习惯；replacesId 给了就改写那一条 */
    add(text: string, example?: string, replacesId?: string | null): Promise<CaptureHabit>
    update(id: string, patch: { text?: string; enabled?: boolean }): Promise<CaptureHabit>
    remove(id: string): Promise<void>
    /** 确认保存速记后，记一次这些习惯的使用 */
    markUsed(ids: string[]): Promise<void>
  }
  courses: {
    list(): Promise<Course[]>
    /** 写入课程并生成到期末的计划时段；replace 时先删掉旧课表 */
    commit(draft: ScheduleDraft, replace: boolean): Promise<{ courses: number; blocks: number }>
    removeAll(): Promise<{ courses: number; blocks: number }>
  }
  resurface: {
    /** day 为按一天起点算的日期 */
    get(day: string): Promise<Resurface>
    act(taskId: string, action: ResurfaceAction): Promise<Task>
    /** 换一批随机推送 */
    reroll(day: string): Promise<Task[]>
    dismissTidy(day: string): Promise<void>
  }
  review: {
    summary(day: string): Promise<DaySummary>
    save(day: string, input: DailyReviewInput): Promise<DailyReview>
  }
  weekly: {
    /** weekStart 为那一周的周一 */
    stats(weekStart: string): Promise<WeekStats>
    /** 有内容的周（周一日期），从早到晚 */
    activeWeeks(): Promise<string[]>
    get(weekStart: string): Promise<WeeklyReview | null>
    /** 让 AI 写本周深度复盘（会覆盖之前的报告和对话） */
    generate(weekStart: string): Promise<WeeklyReview>
    ask(weekStart: string, question: string): Promise<ReviewMessage>
    /** 采纳一条建议：执行它附带的改动 */
    apply(weekStart: string, suggestionId: string): Promise<WeeklyReview>
    dismiss(weekStart: string, suggestionId: string): Promise<WeeklyReview>
  }
  insights: {
    list(): Promise<Insight[]>
    update(id: string, patch: { status?: InsightStatus; text?: string }): Promise<Insight>
    remove(id: string): Promise<void>
  }
  planner: {
    /** 让 AI 给某一天出排程建议，只返回草稿，不写入 */
    suggest(day: string, hint: string): Promise<PlanSuggestion>
    /** 写入用户勾选的建议时段 */
    accept(day: string, blocks: SuggestedBlock[]): Promise<{ created: number }>
  }
}
