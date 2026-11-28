import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { AiApiFormat } from '@shared/types'
import { migrate } from '../db/schema'
import { AiConfigStore } from './config'
import { chat } from './client'

const response = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
const endpoint = { apiFormat: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: 'test-only-key', model: 'test-model' }

describe('Messages 接入的兼容边界', () => {
  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
    [' https://api.anthropic.com/v1/messages/ ', 'https://api.anthropic.com/v1/messages'],
    ['https://proxy.example/claude/v1/messages', 'https://proxy.example/claude/v1/messages']
  ])('规范化实际请求地址：%s', async (baseUrl, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    await chat({ ...endpoint, baseUrl }, [{ role: 'user', content: 'hi' }], { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe(expected)
  })

  it('将 system 文本抽出，并依序合并连续 user 和 assistant', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    await chat(endpoint, [
      { role: 'system', content: [{ type: 'text', text: '规则一' }] },
      { role: 'user', content: '问题一' },
      { role: 'system', content: '规则二' },
      { role: 'user', content: '补充' },
      { role: 'assistant', content: '回答一' },
      { role: 'assistant', content: [{ type: 'text', text: '回答二' }] },
      { role: 'user', content: '追问' }
    ], { fetchImpl, json: true, reasoningEffort: 'high' })
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.system).toBe('规则一\n\n规则二')
    expect(body.max_tokens).toBe(8192)
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '问题一' }, { type: 'text', text: '补充' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }, { type: 'text', text: '回答二' }] },
      { role: 'user', content: '追问' }
    ])
    expect(body.response_format).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it.each(['http://images.example/a.png', 'https://images.example/a.webp'])('保留网络图片：%s', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
    await chat(endpoint, [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }], { fetchImpl })
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.messages[0].content).toEqual([{ type: 'image', source: { type: 'url', url } }])
  })

  it('拒绝不受支持的图片地址，且不发请求', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(chat(endpoint, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///test-only.png' } }] }], { fetchImpl })).rejects.toThrow('不支持的图片格式')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('真实旧配置未包含 apiFormat 时保留 OpenAI 行为及已有模型和 key', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      migrate(db)
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai.config', JSON.stringify({ enabled: true, baseUrl: 'https://proxy.example/v1', model: 'old-model', apiKey: 'test-old-key', keyEncrypted: false }))
      const store = new AiConfigStore(db, { available: () => false, encrypt: (s) => s, decrypt: (s) => s })
      expect(store.view().apiFormat).toBe('openai')
      expect(store.endpoint()).toEqual({ apiFormat: 'openai', baseUrl: 'https://proxy.example/v1', model: 'old-model', apiKey: 'test-old-key' })
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'old-ok' } }] })))
      expect(await chat(store.endpoint(), [{ role: 'user', content: 'hi' }], { fetchImpl })).toBe('old-ok')
      expect(fetchImpl.mock.calls[0][0]).toBe('https://proxy.example/v1/chat/completions')
      expect(fetchImpl.mock.calls[0][1]!.headers).toMatchObject({ authorization: 'Bearer test-old-key' })
    } finally { db.close() }
  })

  it.each((['openai', 'anthropic'] as AiApiFormat[]).flatMap(format => [401, 403].map(status => ({ format, status }))))('$format 的 $status 文案可读且不展示服务端回显的 key', async ({ format, status }) => {
    const apiKey = 'test-secret-should-not-leak'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid key: ' + apiKey } }), { status }))
    let message = ''
    try { await chat({ ...endpoint, apiFormat: format, apiKey }, [{ role: 'user', content: 'hi' }], { fetchImpl }) }
    catch (error) { message = (error as Error).message }
    expect(message).toContain('API Key 不对或没有权限')
    expect(message).not.toContain(apiKey)
  })
})
