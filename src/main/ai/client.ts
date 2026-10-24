/**
 * OpenAI 兼容的 Chat Completions 客户端。只用 fetch，不依赖 SDK，
 * 这样 DeepSeek、通义、Kimi、OpenAI、本地 Ollama 等都能接。
 */

export interface AiEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export class AiError extends Error {}

type Fetch = typeof fetch

/** 规范化 Base URL：去掉结尾斜杠和误填的 /chat/completions */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

export async function chat(
  ep: AiEndpoint,
  messages: ChatMessage[],
  opts: { json?: boolean; timeoutMs?: number; fetchImpl?: Fetch; temperature?: number; reasoningEffort?: 'low' | 'medium' | 'high' } = {}
): Promise<string> {
  if (!ep.baseUrl) throw new AiError('还没有填写 AI 接口地址')
  if (!ep.model) throw new AiError('还没有填写模型名称')
  const url = `${normalizeBaseUrl(ep.baseUrl)}/chat/completions`
  const body: Record<string, unknown> = { model: ep.model, messages, temperature: opts.temperature ?? 0.1 }
  if (opts.json) body.response_format = { type: 'json_object' }
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const send = (b: Record<string, unknown>) =>
      doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {})
        },
        body: JSON.stringify(b),
        signal: ctrl.signal
      })
    let res = await send(body)
    // 有些服务不支持 response_format，去掉再试一次
    if (res.status === 400 && body.response_format) {
      const text = await res.text()
      if (/response_format|json_object/i.test(text)) {
        delete body.response_format
        res = await send(body)
      } else {
        throw httpError(400, text)
      }
    }
    if (!res.ok) throw httpError(res.status, await res.text())
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new AiError('AI 没有返回内容')
    return content
  } catch (e) {
    if (e instanceof AiError) throw e
    if ((e as Error).name === 'AbortError') throw new AiError('AI 响应超时，请稍后再试')
    throw new AiError(`连不上 AI 接口：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

function httpError(status: number, text: string): AiError {
  let detail = ''
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? ''
  } catch {
    detail = text.slice(0, 200)
  }
  const hint =
    status === 401 || status === 403
      ? 'API Key 不对或没有权限'
      : status === 404
        ? '接口地址或模型名称不对'
        : status === 429
          ? '请求太频繁或额度用完了'
          : `接口返回错误 ${status}`
  return new AiError(`${hint}${detail ? `：${detail}` : ''}`)
}

/**
 * 从模型输出里取出 JSON：兼容 ```json 代码块、前后多余文字。
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.search(/[{[]/)
  if (start === -1) throw new AiError('AI 没有返回结构化结果')
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(close)
  if (end <= start) throw new AiError('AI 返回的结果不完整')
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    throw new AiError('AI 返回的结果不是有效的 JSON')
  }
}
