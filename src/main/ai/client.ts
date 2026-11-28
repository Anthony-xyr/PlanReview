/**
 * OpenAI-compatible Chat Completions and Anthropic Messages API client.
 * Uses native fetch with zero SDK dependencies.
 */

import type { AiApiFormat } from '@shared/types'

export interface AiEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: AiApiFormat
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export class AiError extends Error {}

type Fetch = typeof fetch

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 8192

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/** 规范化 Base URL：去掉结尾斜杠和误填的接口后缀 */
export function normalizeBaseUrl(url: string, format: AiApiFormat = 'openai'): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return format === 'anthropic' ? trimmed.replace(/\/messages$/, '') : trimmed.replace(/\/chat\/completions$/, '')
}

function anthropicMessagesUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl, 'anthropic')
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

function contentText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function toAnthropicBlocks(content: string | ContentPart[]): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = part.image_url.url.trim()
    const dataUrl = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
    if (dataUrl) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrl[1].trim(),
          data: dataUrl[2].trim()
        }
      }
    }
    if (/^https?:\/\//i.test(url)) {
      return { type: 'image', source: { type: 'url', url } }
    }
    throw new AiError('不支持的图片格式')
  })
}

function toAnthropicPayload(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const systems: string[] = []
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentText(m.content).trim()
      if (text) systems.push(text)
      continue
    }
    const content: string | AnthropicContentBlock[] = typeof m.content === 'string' ? m.content : toAnthropicBlocks(m.content)
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      const prevBlocks = typeof prev.content === 'string' ? [{ type: 'text' as const, text: prev.content }] : prev.content
      const nextBlocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
      prev.content = [...prevBlocks, ...nextBlocks]
    } else {
      out.push({ role: m.role, content })
    }
  }
  return { system: systems.join('\n\n'), messages: out }
}

export async function chat(
  ep: AiEndpoint,
  messages: ChatMessage[],
  opts: { json?: boolean; timeoutMs?: number; fetchImpl?: Fetch; temperature?: number; reasoningEffort?: 'low' | 'medium' | 'high' } = {}
): Promise<string> {
  if (!ep.baseUrl) throw new AiError('还没有填写 AI 接口地址')
  if (!ep.model) throw new AiError('还没有填写模型名称')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  const doFetch = opts.fetchImpl ?? fetch
  try {
    if (ep.apiFormat === 'anthropic') {
      const url = anthropicMessagesUrl(ep.baseUrl)
      const { system, messages: anthropicMessages } = toAnthropicPayload(messages)
      const body: Record<string, unknown> = {
        model: ep.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        temperature: opts.temperature ?? 0.1,
        ...(system ? { system } : {}),
        messages: anthropicMessages
      }
      const send = (b: Record<string, unknown>) =>
        doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            ...(ep.apiKey ? { 'x-api-key': ep.apiKey } : {})
          },
          body: JSON.stringify(b),
          signal: ctrl.signal
        })
      let res = await send(body)
      // 部分模型（如带默认采样限制的新版 Claude）拒绝非默认 temperature，去掉后重试一次
      if (res.status === 400 && body.temperature !== undefined) {
        const text = await res.text()
        if (/temperature/i.test(text)) {
          delete body.temperature
          res = await send(body)
        } else {
          throw httpError(400, text)
        }
      }
      if (!res.ok) throw httpError(res.status, await res.text())
      const data = (await res.json()) as { content?: { type?: string; text?: unknown }[] }
      const content = (data.content ?? [])
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
      if (!content.trim()) throw new AiError('AI 没有返回内容')
      return content
    }

    const url = `${normalizeBaseUrl(ep.baseUrl, 'openai')}/chat/completions`
    const body: Record<string, unknown> = { model: ep.model, messages, temperature: opts.temperature ?? 0.1 }
    if (opts.json) body.response_format = { type: 'json_object' }
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

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
    // 有些服务不支持 response_format 或非默认 temperature，去掉对应字段再试一次
    for (let retry = 0; retry < 2 && res.status === 400; retry++) {
      const text = await res.text()
      let changed = false
      if (body.response_format && /response_format|json_object/i.test(text)) {
        delete body.response_format
        changed = true
      }
      if (body.temperature !== undefined && /temperature/i.test(text)) {
        delete body.temperature
        changed = true
      }
      if (!changed) throw httpError(400, text)
      res = await send(body)
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
  // 鉴权错误的服务端正文可能回显密钥，只展示固定提示。
  if (status === 401 || status === 403) return new AiError('API Key 不对或没有权限，请检查密钥与服务商权限')
  let detail = ''
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? ''
  } catch {
    detail = text.slice(0, 200)
  }
  const hint =
    status === 404
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
