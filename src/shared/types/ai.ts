// ---------- AI 配置与速记 ----------

/** 推理强度，对应 OpenAI 兼容接口的 reasoning_effort */
export type ReasoningEffort = 'low' | 'medium' | 'high'
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']

/** 用到 AI 的场景 */
export type AiTask = 'capture' | 'schedule' | 'planner' | 'weeklyReview' | 'weeklyQA'

/** AI 接口协议格式 */
export type AiApiFormat = 'openai' | 'anthropic'
export const AI_API_FORMATS: AiApiFormat[] = ['openai', 'anthropic']

/** OpenAI 兼容 / Anthropic Messages 接口配置；界面拿不到明文 Key */
export interface AiConfigView {
  enabled: boolean
  apiFormat: AiApiFormat
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
