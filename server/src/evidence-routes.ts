import { Router } from 'express'
import { z } from 'zod'
import { authOf, requireAuth } from './auth'
import {
  addEvidence,
  buildLocalBundle,
  deleteEvidence,
  importEvidence,
  listEvidence,
  probeSources,
  proxyHint,
} from './evidence'
import { evidenceInputSchema } from '../../shared/types'
import { searchXhsNotes, xhsChannelStatus } from './xhs-notes'
import type { ApiResult, Evidence, EvidenceBundle, SourceStatus, XhsChannelStatus, XhsSearchResult } from '../../shared/types'

const importSchema = z.object({ csv: z.string().min(1, '请粘贴 CSV 内容').max(200_000, 'CSV 内容过长') })

export const CSV_TEMPLATE = [
  'poiName,source,rating,ratingRaw,ratingScale,reviewCount,url,snippet',
  '宽窄巷子,google_places,4.5,4.5/5,5,12830,https://www.google.com/maps,街巷氛围好',
  '宽窄巷子,manual,4.2,4.2/5,5,,,节假日人多',
].join('\n')

/** 逗号分隔的地点名，最多 8 个，避免一次拉起过多外部请求 */
function parsePois(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 8)
}

export const evidenceRouter = Router()

evidenceRouter.get('/evidence', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  res.json({ ok: true, data: listEvidence(userId) } satisfies ApiResult<Evidence[]>)
})

/** 数据源状态：只检查本地配置与熔断状态，不向任何第三方发探测请求 */
evidenceRouter.get('/evidence/sources', requireAuth, (req, res) => {
  const poi = typeof req.query.poi === 'string' ? req.query.poi.slice(0, 120) : ''
  const city = typeof req.query.city === 'string' ? req.query.city.slice(0, 60) : ''
  const data: { sources: SourceStatus[]; proxy: string; csvTemplate: string } = {
    sources: probeSources(poi || '目的地', city),
    proxy: proxyHint(),
    csvTemplate: CSV_TEMPLATE,
  }
  res.json({ ok: true, data } satisfies ApiResult<typeof data>)
})

/** 只读口碑矩阵：本地已存证据 + 各源状态，用于页面预览 */
evidenceRouter.get('/evidence/matrix', requireAuth, (req, res) => {
  const { userId } = authOf(res)
  const pois = parsePois(req.query.pois)
  const city = typeof req.query.city === 'string' ? req.query.city.slice(0, 60) : ''
  res.json({ ok: true, data: buildLocalBundle(userId, pois, city) } satisfies ApiResult<EvidenceBundle>)
})

/** 独立笔记检索通道状态：只检查本地检索服务的 /health，不向小红书发请求 */
evidenceRouter.get('/evidence/xhs/status', requireAuth, async (_req, res) => {
  const data = await xhsChannelStatus()
  res.json({ ok: true, data } satisfies ApiResult<XhsChannelStatus>)
})

/** 关键词检索笔记：未启用或熔断时返回官方搜索深链，不伪造结果 */
evidenceRouter.get('/evidence/xhs/search', requireAuth, async (req, res) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : ''
  const limit = Number(typeof req.query.limit === 'string' ? req.query.limit : 8)
  try {
    const data = await searchXhsNotes(keyword, limit)
    res.json({ ok: true, data } satisfies ApiResult<XhsSearchResult>)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ ok: false, error: message } satisfies ApiResult<never>)
  }
})

evidenceRouter.post('/evidence', requireAuth, (req, res) => {
  const parsed = evidenceInputSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  res.json({ ok: true, data: addEvidence(userId, parsed.data) } satisfies ApiResult<Evidence>)
})

evidenceRouter.post('/evidence/import', requireAuth, (req, res) => {
  const parsed = importSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  try {
    const result = importEvidence(userId, parsed.data.csv)
    res.json({ ok: true, data: { imported: result.imported } } satisfies ApiResult<{ imported: number }>)
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ApiResult<never>)
  }
})

evidenceRouter.delete('/evidence/:id', requireAuth, (req, res) => {
  const { userId } = authOf(res)
  const deleted = deleteEvidence(userId, req.params.id)
  if (!deleted) {
    res.status(404).json({ ok: false, error: '证据记录不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: { deleted: true } } satisfies ApiResult<{ deleted: boolean }>)
})
