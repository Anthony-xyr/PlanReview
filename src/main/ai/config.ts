import type { DatabaseSync } from 'node:sqlite'
import type { AiConfigPatch, AiConfigView, AiTask, ReasoningEffort } from '@shared/types'
import { REASONING_EFFORTS } from '@shared/types'
import type { AiEndpoint } from './client'
import { normalizeBaseUrl } from './client'

/** 系统加密接口（Electron safeStorage），测试时可替换 */
export interface SecretBox {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

const KEY = 'ai.config'

interface Stored {
  enabled: boolean
  baseUrl: string
  model: string
  visionModel: string
  parseCapture: boolean
  /** 加密后的 Key（base64），或明文（系统不支持加密时） */
  apiKey: string
  keyEncrypted: boolean
  reasoningEffort: Record<AiTask, ReasoningEffort>
}

const isEffort = (v: unknown): v is ReasoningEffort => REASONING_EFFORTS.includes(v as ReasoningEffort)

const DEFAULTS: Stored = {
  enabled: false,
  baseUrl: '',
  model: '',
  visionModel: '',
  parseCapture: true,
  apiKey: '',
  keyEncrypted: false,
  reasoningEffort: {
    capture: 'low',
    schedule: 'medium',
    planner: 'low',
    weeklyReview: 'high',
    weeklyQA: 'medium'
  }
}

/** AI 配置存在 settings 表里，Key 用系统加密后保存，界面永远拿不到明文 */
export class AiConfigStore {
  constructor(
    private db: DatabaseSync,
    private box: SecretBox
  ) {}

  private load(): Stored {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined
    const saved = row ? (JSON.parse(row.value) as Partial<Stored>) : {}
    // 推理强度逐项合并：旧版本存的是单个字符串或缺项，新增场景时也能拿到默认值
    const effort = { ...DEFAULTS.reasoningEffort }
    if (saved.reasoningEffort && typeof saved.reasoningEffort === 'object')
      for (const [k, v] of Object.entries(saved.reasoningEffort)) if (k in effort && isEffort(v)) effort[k as AiTask] = v
    return { ...DEFAULTS, ...saved, reasoningEffort: effort }
  }

  /** 某个场景该用的推理强度 */
  effort(task: AiTask): ReasoningEffort {
    return this.load().reasoningEffort[task]
  }

  private save(s: Stored): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY, JSON.stringify(s))
  }

  view(): AiConfigView {
    const s = this.load()
    return {
      enabled: s.enabled,
      baseUrl: s.baseUrl,
      model: s.model,
      visionModel: s.visionModel,
      parseCapture: s.parseCapture,
      hasKey: !!s.apiKey,
      keyEncrypted: s.keyEncrypted,
      reasoningEffort: s.reasoningEffort
    }
  }

  update(patch: AiConfigPatch): AiConfigView {
    const s = this.load()
    if (patch.baseUrl !== undefined) {
      const url = normalizeBaseUrl(patch.baseUrl)
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('接口地址应以 http:// 或 https:// 开头')
      s.baseUrl = url
    }
    if (patch.model !== undefined) s.model = patch.model.trim()
    if (patch.visionModel !== undefined) s.visionModel = patch.visionModel.trim()
    if (patch.enabled !== undefined) s.enabled = patch.enabled
    if (patch.parseCapture !== undefined) s.parseCapture = patch.parseCapture
    if (patch.reasoningEffort)
      for (const [k, v] of Object.entries(patch.reasoningEffort)) if (k in s.reasoningEffort && isEffort(v)) s.reasoningEffort[k as AiTask] = v
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim()
      if (!key) {
        s.apiKey = ''
        s.keyEncrypted = false
      } else if (this.box.available()) {
        s.apiKey = this.box.encrypt(key)
        s.keyEncrypted = true
      } else {
        s.apiKey = key
        s.keyEncrypted = false
      }
    }
    this.save(s)
    return this.view()
  }

  /** 供主进程调用接口用；vision 为 true 时优先用识图模型 */
  endpoint(vision = false): AiEndpoint {
    const s = this.load()
    if (!s.enabled) throw new Error('AI 功能还没有开启，请到设置里配置')
    const apiKey = s.apiKey ? (s.keyEncrypted ? this.box.decrypt(s.apiKey) : s.apiKey) : ''
    return { baseUrl: s.baseUrl, apiKey, model: (vision && s.visionModel) || s.model }
  }

  captureEnabled(): boolean {
    const s = this.load()
    return s.enabled && s.parseCapture && !!s.baseUrl && !!s.model
  }
}
