import type { UpdateApi } from '../update'
import type { AiConfigPatch, AiConfigView, CaptureDraft, CaptureHabit, CaptureParse, CaptureReparse, HabitKind, PlanAcceptance, PlanReplan, PlanSuggestion, SuggestedBlock } from './ai'
import type { Course, ImportFile, ScheduleDraft } from './course'
import type { BlockInput, EntryInput, OverrunReason, PlanBlock, StartTimerInput, StopResult, StopTimerInput, TimeEntry } from './plan'
import type { DailyReview, DailyReviewInput, DaySummary, Resurface, ResurfaceAction } from './review'
import type { MainCommand, Reminder, Settings, SystemStatus, TimerOverlayState } from './system'
import type { Category, Task, TaskFilter, TaskInput } from './task'
import type { Insight, InsightStatus, ReviewMessage, WeeklyReview, WeekStats } from './weekly'

/** 预加载脚本暴露给界面的接口 */
export interface Api {
  update: UpdateApi
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
    startedIds(from: string, to: string): Promise<string[]>
    create(input: BlockInput): Promise<PlanBlock>
    copy(id: string, startAt: string): Promise<PlanBlock>
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
    onResume(cb: () => void): () => void
  }
  win: {
    openMain(cmd?: MainCommand): Promise<void>
    showFloat(): Promise<void>
    hideFloat(): Promise<void>
    floatReady(): Promise<void>
    resizeFloat(height: number): Promise<void>
    status(): Promise<SystemStatus>
    platform: string
  }
  timer: {
    state(): Promise<TimerOverlayState>
    resize(width: number): Promise<void>
    onState(cb: (state: TimerOverlayState) => void): () => void
    onHover(cb: (hovered: boolean) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    getBackgroundImage(): Promise<string | null>
    /** 图片为本地转换后的 WebP；undefined 保留，null 移除。与设置一起保存。 */
    update(patch: Partial<Settings>, backgroundImage?: string | null): Promise<Settings>
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
    list(kind?: HabitKind): Promise<CaptureHabit[]>
    /** 记下一条习惯；replacesId 给了就改写那一条 */
    add(text: string, example?: string, replacesId?: string | null, kind?: HabitKind): Promise<CaptureHabit>
    update(id: string, patch: { text?: string; enabled?: boolean }, kind?: HabitKind): Promise<CaptureHabit>
    remove(id: string, kind?: HabitKind): Promise<void>
    /** 确认保存速记后，记一次这些习惯的使用 */
    markUsed(ids: string[], kind?: HabitKind): Promise<void>
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
    /** 按历次纠正重排，只生成草稿，不写入习惯 */
    replan(day: string, hint: string, previous: SuggestedBlock[], feedback: string[]): Promise<PlanReplan>
    /** 写入用户勾选的建议时段 */
    accept(day: string, blocks: SuggestedBlock[], confirmation?: PlanAcceptance): Promise<{ created: number }>
  }
}
