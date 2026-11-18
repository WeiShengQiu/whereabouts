import { z } from 'zod'
import type { XhsChannelStatus, XhsNote, XhsSearchResult } from '../../shared/types'

/**
 * 小红书笔记检索通道（默认关闭）。
 *
 * 主服务只调用部署者自己启动的 HTTP 检索服务，不实现任何签名、不模拟浏览器、不绕过风控。
 * 返回内容只用于页面检索展示，不落库、不注入模型提示词、不写入导出的 HTML。
 * 403/429/风控与上游不可用一律降级为官方搜索入口，5 分钟内不再请求。
 */

const noteSchema = z.object({
  id: z.string().max(64),
  title: z.string().max(200).default(''),
  author: z.string().max(80).default(''),
  likes: z.number().int().nonnegative().nullable().default(null),
  collects: z.number().int().nonnegative().nullable().default(null),
  comments: z.number().int().nonnegative().nullable().default(null),
  noteType: z.string().max(20).default(''),
  url: z.string().max(600),
  fetchedAt: z.string().max(40).default(''),
})

const successSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    query: z.string(),
    count: z.number(),
    items: z.array(noteSchema),
  }),
})

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  message: z.string(),
})

const healthSchema = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  reason: z.string().default(''),
  minInterval: z.number().nullable().default(null),
  maxLimit: z.number().nullable().default(null),
})

const CIRCUIT_MS = 5 * 60_000
let circuitUntil = 0
let circuitReason = ''

function activeCircuit(): string | null {
  if (circuitUntil <= Date.now()) return null
  return circuitReason
}

function tripCircuit(reason: string): void {
  circuitUntil = Date.now() + CIRCUIT_MS
  circuitReason = reason
}

interface ChannelConfig {
  enabled: boolean
  url: string
  token: string
}

function channelConfig(): ChannelConfig {
  const url = (process.env.XHS_NOTES_URL ?? 'http://127.0.0.1:8901').trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('协议不支持')
  } catch {
    throw new Error('XHS_NOTES_URL 不是合法的 http(s) 地址')
  }
  return {
    enabled: process.env.XHS_NOTES_ENABLED === '1',
    url,
    token: (process.env.XHS_NOTES_TOKEN ?? '').trim(),
  }
}

export function xhsDeepLink(query: string): string {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`
}

const COMPLIANCE = [
  '独立研究通道：上游为第三方开源项目，自述「仅供学习交流使用，禁止任何商业化行为」且未提供 LICENSE。',
  '仅可使用本人账号 Cookie、低频检索；结果只展示标题与互动数，不缓存正文与图片，不产生评分。',
  '主服务不含任何签名或反爬代码；是否启用及合规责任由部署者自行承担，生产环境请改用平台官方授权接口。',
].join(' ')

/** 状态检查只访问检索服务的 /health，不触发对小红书的任何请求 */
export async function xhsChannelStatus(): Promise<XhsChannelStatus> {
  const base = { deepLink: xhsDeepLink('目的地 攻略'), compliance: COMPLIANCE }
  const config = channelConfig()
  if (!config.enabled) {
    return {
      enabled: false,
      ready: false,
      reason: '未启用：当前只提供官方搜索入口，不向第三方发请求',
      minInterval: null,
      maxLimit: null,
      ...base,
    }
  }
  if (!config.token) {
    return { enabled: true, ready: false, reason: '已启用但缺少 XHS_NOTES_TOKEN', minInterval: null, maxLimit: null, ...base }
  }
  const circuit = activeCircuit()
  if (circuit) {
    return { enabled: true, ready: false, reason: `已熔断：${circuit}；5 分钟后自动恢复`, minInterval: null, maxLimit: null, ...base }
  }
  try {
    const response = await fetch(`${config.url}/health`, {
      headers: { 'X-Sidecar-Token': config.token, accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    const parsed = healthSchema.safeParse(JSON.parse(await response.text()) as unknown)
    if (!parsed.success) throw new Error('检索服务返回结构异常')
    return {
      enabled: true,
      ready: parsed.data.ready,
      reason: parsed.data.reason || (parsed.data.ready ? '通道已就绪' : '通道未就绪'),
      minInterval: parsed.data.minInterval,
      maxLimit: parsed.data.maxLimit,
      ...base,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { enabled: true, ready: false, reason: `检索服务不可达：${message}`, minInterval: null, maxLimit: null, ...base }
  }
}

/** 只接受小红书官方域名链接，避免把任意 URL 带进页面 */
function safeNoteUrl(url: string): string | null {
  return /^https:\/\/(www\.)?xiaohongshu\.com\/(explore|discovery\/item)\//i.test(url) ? url : null
}

export async function searchXhsNotes(keywordRaw: string, limitRaw: number): Promise<XhsSearchResult> {
  const query = keywordRaw.trim().slice(0, 60)
  if (query.length < 2) throw new Error('关键词至少 2 个字符')
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.trunc(limitRaw))) : 8
  const deepLink = xhsDeepLink(query)
  const config = channelConfig()

  if (!config.enabled) {
    return {
      query,
      count: 0,
      items: [],
      mode: 'disabled',
      notice: '笔记检索通道未启用；可点下方「打开小红书搜索」自行查询，或按 README 配置独立检索服务。',
      deepLink,
    }
  }
  if (!config.token) throw new Error('已启用笔记检索通道，但未配置 XHS_NOTES_TOKEN')

  const circuit = activeCircuit()
  if (circuit) {
    return {
      query,
      count: 0,
      items: [],
      mode: 'degraded',
      notice: `检索通道已熔断（${circuit}），5 分钟内不再请求；已降级为官方搜索入口。`,
      deepLink,
    }
  }

  const target = `${config.url}/search?keyword=${encodeURIComponent(query)}&limit=${limit}&sort=general`
  let response: Response
  try {
    response = await fetch(target, {
      headers: { 'X-Sidecar-Token': config.token, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`笔记检索服务不可达：${message}；请确认 sidecar 已启动，或先用官方搜索入口`)
  }

  const raw = await response.text()
  if (response.status === 403 || response.status === 429) {
    tripCircuit(`HTTP ${response.status} 风控或限流`)
    return {
      query,
      count: 0,
      items: [],
      mode: 'degraded',
      notice: '上游触发风控或限流，已熔断 5 分钟并降级为官方搜索入口（不重试、不换身份）。',
      deepLink,
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw) as unknown
  } catch {
    throw new Error('笔记检索服务返回的不是合法 JSON')
  }
  const failure = failureSchema.safeParse(payload)
  if (failure.success) {
    if (failure.data.error === 'RISK_CONTROL') {
      tripCircuit(failure.data.message.slice(0, 120))
      return {
        query,
        count: 0,
        items: [],
        mode: 'degraded',
        notice: `${failure.data.message}；已降级为官方搜索入口。`,
        deepLink,
      }
    }
    throw new Error(`笔记检索失败：${failure.data.message}`)
  }
  if (!response.ok) throw new Error(`笔记检索服务返回 HTTP ${response.status}`)

  const parsed = successSchema.safeParse(payload)
  if (!parsed.success) throw new Error('笔记检索服务返回结构异常，已丢弃本次结果')
  const items: XhsNote[] = parsed.data.data.items
    .slice(0, limit)
    .flatMap((item) => {
      const url = safeNoteUrl(item.url)
      return url ? [{ ...item, url }] : []
    })

  return {
    query,
    count: items.length,
    items,
    mode: 'live',
    notice: `检索到 ${items.length} 条笔记（仅标题、作者、互动数与回源链接，无评分、不落库）。`,
    deepLink,
  }
}
