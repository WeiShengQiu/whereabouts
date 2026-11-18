/**
 * 小红书笔记封面图代理。
 *
 * 为什么需要代理：
 * 1. 小红书图床对「外站 Referer」有防盗链，直接 <img src="https://sns-...xhscdn.com/...">
 *    在平台域名下经常 403，表现为封面空白；
 * 2. 部分历史数据存的是协议相对地址（//sns-...），浏览器会按页面协议解析成 http，被拒。
 *
 * 做法：只放行小红书官方图床域名，服务端带小红书 Referer 取图并回传给前端。
 * 图片只在内存里做短时缓存（LRU + TTL），不落盘、不写库，避免版权与缓存合规问题。
 */
import { Router, type Request, type Response } from 'express'
import { requireAuth } from './auth'

const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 8000
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 150

interface CacheEntry {
  body: Buffer
  type: string
  at: number
}

const cache = new Map<string, CacheEntry>()

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'xhscdn.com' || host.endsWith('.xhscdn.com') ||
    host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')
}

/** 归一化并校验封面地址：只接受小红书官方图床的 https 图片 */
export function normalizeCoverUrl(raw: string): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (value.startsWith('//')) value = `https:${value}`
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (!hostAllowed(url.hostname)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function readCache(key: string): CacheEntry | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  // 命中即刷新，近似 LRU
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.set(key, entry)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export const xhsCoverRouter = Router()

/**
 * GET /api/xhs-research/cover?u=<encoded>
 * 直接回图片字节流；失败返回 404 且不带正文，前端据此隐藏封面而不显示破图。
 */
xhsCoverRouter.get('/xhs-research/cover', requireAuth, async (req: Request, res: Response) => {
  const target = normalizeCoverUrl(String(req.query.u ?? ''))
  if (!target) {
    res.status(400).end()
    return
  }
  const cached = readCache(target)
  if (cached) {
    res.setHeader('Content-Type', cached.type)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.end(cached.body)
    return
  }
  try {
    const response = await fetch(target, {
      headers: {
        // 关键：带小红书站内 Referer，绕开外站防盗链
        Referer: 'https://www.xiaohongshu.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // 跟随跳转后再校验一次最终域名，防止被重定向到内网或其他站点
    if (response.ok && hostAllowed(new URL(response.url).hostname)) {
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      if (type.startsWith('image/')) {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length > 0 && body.length <= MAX_BYTES) {
          writeCache(target, { body, type, at: Date.now() })
          res.setHeader('Content-Type', type)
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(body)
          return
        }
      }
    }
    res.status(404).end()
  } catch {
    // 上游超时 / 网络不可达：不回 5xx，避免前端把它当成业务错误
    res.status(404).end()
  }
})
