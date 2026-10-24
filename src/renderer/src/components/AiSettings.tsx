import { useEffect, useState } from 'react'
import type { AiConfigView, AiTask, ReasoningEffort } from '@shared/types'
import { REASONING_EFFORTS } from '@shared/types'
import { errorText } from '../ui'

/** 常见服务的接口地址，选了自动填 */
const PRESETS: { name: string; baseUrl: string; model: string; vision?: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: 'qwen-vl-max' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', vision: 'glm-4v-plus' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: '' }
]

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** 各场景的推理强度：简单的拆分求快，复盘这类要想得深 */
const EFFORT_TASKS: { key: AiTask; label: string; suggest: ReasoningEffort }[] = [
  { key: 'capture', label: '速记解析', suggest: 'low' },
  { key: 'planner', label: '帮我排时间', suggest: 'low' },
  { key: 'schedule', label: '课表识别', suggest: 'medium' },
  { key: 'weeklyReview', label: '周复盘生成', suggest: 'high' },
  { key: 'weeklyQA', label: '周复盘追问', suggest: 'medium' }
]

/** AI 设置：单独保存，不跟着设置对话框的「保存」走，这样能先测试再用 */
export function AiSettings() {
  const [cfg, setCfg] = useState<AiConfigView | null>(null)
  const [form, setForm] = useState<{ baseUrl: string; model: string; visionModel: string; reasoningEffort: Record<AiTask, ReasoningEffort> }>({
    baseUrl: '',
    model: '',
    visionModel: '',
    reasoningEffort: { capture: 'low', schedule: 'medium', planner: 'low', weeklyReview: 'high', weeklyQA: 'medium' }
  })
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.ai.getConfig().then((c) => {
      setCfg(c)
      setForm({ baseUrl: c.baseUrl, model: c.model, visionModel: c.visionModel, reasoningEffort: c.reasoningEffort })
    })
  }, [])

  if (!cfg) return null

  const save = async (extra: Partial<AiConfigView> = {}) => {
    const c = await window.api.ai.setConfig({ ...form, ...extra, ...(key ? { apiKey: key } : {}) })
    setCfg(c)
    setKey('')
    return c
  }

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus({ text: await fn() })
    } catch (e) {
      setStatus({ text: errorText(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>AI</h3>
      <p className="muted">
        这一栏单独保存。支持所有兼容 OpenAI 格式的服务。速记解析、课表导入时，相关文字和图片会发给你配置的服务商；数据本身只存在本机。
      </p>
      <label className="check">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => run(async () => (await save({ enabled: e.target.checked })).enabled ? '已开启 AI' : '已关闭 AI，不会再发送任何内容')} />
        开启 AI 功能
      </label>

      {cfg.enabled && (
        <>
          <div className="preset-row" role="group" aria-label="常用服务">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                className="preset"
                onClick={() => setForm({ ...form, baseUrl: p.baseUrl, model: p.model, visionModel: p.vision ?? '' })}
              >
                {p.name}
              </button>
            ))}
          </div>
          <label className="field">
            <span>接口地址（Base URL）</span>
            <input value={form.baseUrl} placeholder="https://api.deepseek.com" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>API Key {cfg.hasKey && <em className="muted">（已保存{cfg.keyEncrypted ? '，系统加密' : '，未加密'}；留空表示不改）</em>}</span>
            <input type="password" autoComplete="off" value={key} placeholder={cfg.hasKey ? '••••••••' : 'sk-…'} onChange={(e) => setKey(e.target.value)} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>模型</span>
              <input value={form.model} placeholder="deepseek-chat" onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </label>
            <label className="field">
              <span>识图模型（可选）</span>
              <input value={form.visionModel} placeholder="同上" onChange={(e) => setForm({ ...form, visionModel: e.target.value })} />
            </label>
          </div>
          <p className="muted">课表截图需要支持识图的模型。DeepSeek 目前不能识图，可以只上传 PDF / Excel，或另配一个识图模型。</p>

          <h4 className="settings-sub">推理强度</h4>
          <p className="muted">模型支持时生效（reasoning_effort）。Low 最快，High 想得最深、也最慢。</p>
          <div className="effort-grid">
            {EFFORT_TASKS.map((t) => (
              <label key={t.key} className="field">
                <span>{t.label}</span>
                <select
                  value={form.reasoningEffort[t.key]}
                  onChange={(e) => setForm({ ...form, reasoningEffort: { ...form.reasoningEffort, [t.key]: e.target.value as ReasoningEffort } })}
                >
                  {REASONING_EFFORTS.map((v) => (
                    <option key={v} value={v}>
                      {EFFORT_LABEL[v]}
                      {v === t.suggest ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <label className="check">
            <input type="checkbox" checked={cfg.parseCapture} onChange={(e) => run(async () => ((await save({ parseCapture: e.target.checked })).parseCapture ? '速记会先交给 AI 拆分' : '速记直接存原文'))} />
            速记时用 AI 拆出日期、估时、大类（确认后才保存）
          </label>
          <div className="dialog-actions">
            {cfg.hasKey && (
              <button type="button" className="link" disabled={busy} onClick={() => run(async () => (await window.api.ai.setConfig({ apiKey: '' }), setCfg(await window.api.ai.getConfig()), '已删除 API Key'))}>
                删除 Key
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => (await save(), '已保存'))}>
              保存 AI 设置
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await save()
                  const r = await window.api.ai.test()
                  return `连接正常：${r.model}，用时 ${(r.ms / 1000).toFixed(1)} 秒`
                })
              }
            >
              {busy ? '请稍候…' : '保存并测试'}
            </button>
          </div>
        </>
      )}
      {status && <p className={status.error ? 'form-error' : 'form-ok'} role="status">{status.text}</p>}
    </section>
  )
}
