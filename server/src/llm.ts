import { db } from './db'
import { decryptSecret, encryptSecret, newId } from './crypto'
import { DEFAULT_CONFIG_ID } from '../../shared/types'
import type { LLMConfigInput, LLMConfigUpdate, LLMConfigView, ModelInfo, Protocol } from '../../shared/types'

/** 用户可能直接粘贴完整端点，去掉已知路径后缀后统一按「API 版本前缀」存储 */
export function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  for (const suffix of ['/chat/completions', '/responses', '/messages']) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      break
    }
  }
  return base.replace(/\/+$/, '')
}

interface ConfigRow {
  id: string
  user_id: string
  name: string
  protocol: Protocol
  base_url: string
  api_key_cipher: string
  default_model: string
  created_at: string
}

export interface LLMConfigRecord {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  apiKey: string
  defaultModel: string
}

function toView(row: ConfigRow): LLMConfigView {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    hasApiKey: Boolean(row.api_key_cipher),
    defaultModel: row.default_model,
    createdAt: row.created_at,
  }
}

/**
 * 系统内置默认模型：由 .env 注入，不写数据库、不属于任何用户、接口永不回显密钥。
 * 未设置 DEFAULT_LLM_API_KEY 时返回 null，平台退化为「必须自行新增模型配置」。
 */
export function getDefaultConfig(): LLMConfigRecord | null {
  const baseUrl = process.env.DEFAULT_LLM_BASE_URL?.trim()
  const apiKey = process.env.DEFAULT_LLM_API_KEY?.trim()
  if (!baseUrl || !apiKey) return null
  const raw = process.env.DEFAULT_LLM_PROTOCOL?.trim()
  const protocol: Protocol = raw === 'responses' || raw === 'anthropic_messages' ? raw : 'chat_completions'
  const model = process.env.DEFAULT_LLM_MODEL?.trim() || 'qwen-plus'
  return {
    id: DEFAULT_CONFIG_ID,
    name: `系统默认 · 阿里云百炼 · ${model}`,
    protocol,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    defaultModel: model,
  }
}

/** 默认项排在用户自建配置之后：没有自建配置时前端自然选中它；有自建配置时优先用用户自己的 */
export function listConfigs(userId: string): LLMConfigView[] {
  const rows = db.prepare('SELECT * FROM llm_configs WHERE user_id = ? ORDER BY created_at DESC').all(userId) as ConfigRow[]
  const views = rows.map(toView)
  const builtin = getDefaultConfig()
  if (builtin) {
    views.push({
      id: DEFAULT_CONFIG_ID,
      name: builtin.name,
      protocol: builtin.protocol,
      baseUrl: builtin.baseUrl,
      hasApiKey: true,
      defaultModel: builtin.defaultModel,
      createdAt: '',
    })
  }
  return views
}

export function createConfig(userId: string, input: LLMConfigInput): LLMConfigView {
  const id = newId()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO llm_configs (id, user_id, name, protocol, base_url, api_key_cipher, default_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.protocol,
    normalizeBaseUrl(input.baseUrl),
    encryptSecret(input.apiKey),
    input.defaultModel ?? '',
    createdAt,
  )
  return { id, name: input.name, protocol: input.protocol, baseUrl: normalizeBaseUrl(input.baseUrl), hasApiKey: true, defaultModel: input.defaultModel ?? '', createdAt }
}

export function updateConfig(userId: string, id: string, input: LLMConfigUpdate): LLMConfigView | null {
  const old = db.prepare('SELECT * FROM llm_configs WHERE id = ? AND user_id = ?').get(id, userId) as ConfigRow | undefined
  if (!old) return null
  const cipher = input.apiKey ? encryptSecret(input.apiKey) : old.api_key_cipher
  db.prepare(
    `UPDATE llm_configs SET name = ?, protocol = ?, base_url = ?, api_key_cipher = ?, default_model = ?
     WHERE id = ? AND user_id = ?`,
  ).run(input.name, input.protocol, normalizeBaseUrl(input.baseUrl), cipher, input.defaultModel ?? '', id, userId)
  return toView({ ...old, name: input.name, protocol: input.protocol, base_url: normalizeBaseUrl(input.baseUrl), api_key_cipher: cipher, default_model: input.defaultModel ?? '' })
}

export function deleteConfig(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM llm_configs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

/** 取配置并解密密钥；仅供后端调用，任何路由都不得把 apiKey 返回给前端 */
export function getConfig(userId: string, id: string): LLMConfigRecord | null {
  if (id === DEFAULT_CONFIG_ID) return getDefaultConfig()
  const row = db.prepare('SELECT * FROM llm_configs WHERE id = ? AND user_id = ?').get(id, userId) as ConfigRow | undefined
  if (!row) return null
  let apiKey: string
  try {
    apiKey = decryptSecret(row.api_key_cipher)
  } catch {
    // 更换 APP_ENCRYPTION_KEY 后旧密文无法解开，直接抛底层加密错误会让人无从下手
    throw new Error('该模型配置的 API Key 无法解密（通常因更换过 APP_ENCRYPTION_KEY）：请到「模型设置」编辑此配置并重新填写 API Key')
  }
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    apiKey,
    defaultModel: row.default_model,
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

function requestHeaders(protocol: Protocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (protocol === 'anthropic_messages') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

/** 上游常见错误的中文指引；原文与 request_id 一并保留，便于找服务商对账 */
const UPSTREAM_HINTS: Array<[RegExp, string]> = [
  [/product is not activated/i, '所选模型未在服务商控制台开通/激活：请到模型市场开通后再调用，或换用已开通的模型（阿里云百炼可先试 qwen-plus）'],
  [/unsupported model|model not exist|model_not_found|does not exist/i, '模型名不被该端点支持：请对照服务商模型列表重新填写模型 ID，注意不要混用其他配置的模型名'],
  [/invalid[_ -]?api[_ -]?key|unauthorized|authentication|incorrect api key/i, 'API Key 无效或与该地址、业务空间不匹配，请重新填写'],
  [/insufficient|quota|arrears|balance/i, '账户额度或余额不足，请到服务商控制台检查'],
]

function describeUpstream(status: number, raw: string): string {
  let upstream = raw.slice(0, 200)
  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: { message?: string } }
    upstream = parsed.message ?? parsed.error?.message ?? upstream
  } catch {
    // 非 JSON 响应保留原文即可
  }
  const hint = UPSTREAM_HINTS.find(([pattern]) => pattern.test(upstream))?.[1]
  return `模型服务返回 ${status}${hint ? `：${hint}` : ''}｜上游原文：${raw.slice(0, 220)}`
}

/** 统一超时与错误处理：不回显密钥，只截取有限长度的服务端错误 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(describeUpstream(response.status, raw))
    }
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new Error('模型服务返回的不是合法 JSON')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('模型服务请求超时（120 秒）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
export interface ChatParams {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

interface ChatCompletionsResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
}
interface ResponsesResponse {
  model?: string
  output_text?: string
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
}
interface AnthropicResponse {
  model?: string
  content?: Array<{ type?: string; text?: string }>
}

function extractText(value: unknown, protocol: Protocol): string {
  if (protocol === 'chat_completions') {
    const data = value as ChatCompletionsResponse
    return (data.choices?.[0]?.message?.content ?? '').trim()
  }
  if (protocol === 'responses') {
    const data = value as ResponsesResponse
    if (data.output_text) return data.output_text.trim()
    return (data.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' || item.type === 'text' || !item.type)
      .map((item) => item.text ?? '')
      .join('')
      .trim()
  }
  const data = value as AnthropicResponse
  return (data.content ?? []).filter((item) => item.type === 'text' || !item.type).map((item) => item.text ?? '').join('').trim()
}

/** 三种协议的统一对话入口：非流式，差异全部收口在此 */
export async function chat(config: LLMConfigRecord, params: ChatParams): Promise<{ text: string; model: string }> {
  const headers = requestHeaders(config.protocol, config.apiKey)
  const temperature = params.temperature ?? 0.7
  let path: string
  let body: Record<string, unknown>

  if (config.protocol === 'chat_completions') {
    path = '/chat/completions'
    body = { model: params.model, messages: params.messages, temperature }
    if (params.maxTokens) body.max_tokens = params.maxTokens
  } else if (config.protocol === 'responses') {
    path = '/responses'
    const system = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    body = {
      model: params.model,
      input: params.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      temperature,
    }
    if (system) body.instructions = system
    if (params.maxTokens) body.max_output_tokens = params.maxTokens
  } else {
    path = '/messages'
    const system = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    body = {
      model: params.model,
      system,
      messages: params.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      max_tokens: params.maxTokens ?? 4096,
      temperature,
    }
  }

  const result = await fetchJson(apiUrl(config.baseUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const responseModel = (result as { model?: string })?.model ?? params.model
  const text = extractText(result, config.protocol)
  if (!text) throw new Error('模型返回内容为空，请检查模型名称与协议是否匹配')
  return { text, model: responseModel }
}

/** 中转端点常不实现 /models，失败时明确降级为手动填写而非静默返回空列表 */
export async function listModels(config: LLMConfigRecord): Promise<{ models: ModelInfo[]; manualOnly: boolean; reason: string }> {
  // 默认配置只暴露已验证可用的单个模型：百炼 /models 返回的是平台全量目录，
  // 其中大量模型该账号并未开通，让用户从里面挑会重现「product is not activated」。
  if (config.id === DEFAULT_CONFIG_ID) {
    return {
      models: [{ id: config.defaultModel, ownedBy: '系统预置' }],
      manualOnly: false,
      reason: '系统默认模型已预置，无需配置即可使用；如需其他模型，请在「模型设置」新增自己的配置',
    }
  }
  try {
    const data = await fetchJson(apiUrl(config.baseUrl, '/models'), {
      method: 'GET',
      headers: requestHeaders(config.protocol, config.apiKey),
    })
    const items = (data as { data?: unknown })?.data
    if (!Array.isArray(items)) return { models: [], manualOnly: true, reason: '模型列表返回结构不符合预期，请手动填写模型名' }
    const models: ModelInfo[] = items
      .filter((item): item is { id: string; owned_by?: string; display_name?: string } => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string')
      .map((item) => ({ id: item.id, ownedBy: item.owned_by ?? item.display_name }))
    return { models, manualOnly: false, reason: '' }
  } catch (error) {
    return {
      models: [],
      manualOnly: true,
      reason: `该端点未提供可用的模型列表（${error instanceof Error ? error.message : String(error)}），请手动填写模型名`,
    }
  }
}

export async function testConnection(config: LLMConfigRecord, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await chat(config, {
      model,
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      maxTokens: 32,
    })
    return { ok: true, message: `连通正常（${result.model}）：${result.text.slice(0, 40)}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
