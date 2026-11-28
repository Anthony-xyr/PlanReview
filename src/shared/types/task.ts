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
