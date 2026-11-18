/** 小红书实采研究的 HTTP 路由：检索词生成、线索 CRUD、状态检查 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { authOf, requireAuth } from './auth'
import { getConfig, getDefaultConfig } from './llm'
import {
  clearResearch,
  deleteResearch,
  generateResearchQueries,
  importResearch,
  listResearch,
} from './xhs-research'
import type { ApiResult } from '../../shared/types'

type AsyncHandler = (req: Request, res: Response) => Promise<void>
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => {
  Promise.resolve(fn(req, res)).catch(next)
}

const queriesSchema = z.object({
  requirement: z.string().trim().min(5, '请至少描述 5 个字的旅行需求').max(2000),
  configId: z.string().optional().default(''),
  model: z.string().optional().default(''),
})

// 导入体在 shared/types 里有 researchImportSchema，这里只补充路由层的字段约束
const importSchema = z.object({
  category: z.enum(['hotel', 'transport', 'food', 'attraction']),
  keyword: z.string().trim().max(80).optional().default(''),
  payload: z.object({
    schemaVersion: z.number().optional(),
    app: z.string().optional(),
    loginChecked: z.boolean().optional().default(false),
    loggedIn: z.boolean().optional().default(false),
    extensionVersion: z.string().optional().default(''),
    collectedAt: z.string().optional().default(''),
    items: z.array(z.object({
      title: z.string().optional().default(''),
      author: z.string().optional().default(''),
      likes: z.number().nullable().optional().default(null),
      summary: z.string().optional().default(''),
      link: z.string().optional().default(''),
    })).max(50),
  }),
})

export const xhsResearchRouter = Router()

/** 把需求拆成四类检索词；未登录或无配置时仍返回规则兜底词 */
xhsResearchRouter.post('/xhs-research/queries', requireAuth, wrap(async (req, res) => {
  const parsed = queriesSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  const { configId, model } = parsed.data
  const config = configId ? getConfig(userId, configId) : getDefaultConfig()
  const resolvedModel = model.trim() || config?.defaultModel || getDefaultConfig()?.defaultModel || 'qwen-plus'
  const result = await generateResearchQueries(config, parsed.data.requirement, resolvedModel)
  res.json({ ok: true, data: result } satisfies ApiResult<typeof result>)
}))

/** 读取当前用户的实采线索 */
xhsResearchRouter.get('/xhs-research', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  res.json({ ok: true, data: listResearch(userId) } satisfies ApiResult<ReturnType<typeof listResearch>>)
})

/** 导入扩展采集结果；未登录小红书的采集一律拒绝 */
xhsResearchRouter.post('/xhs-research/import', requireAuth, (req, res) => {
  const parsed = importSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  const { category, keyword, payload } = parsed.data
  const result = importResearch(userId, category, keyword, payload)
  if (result.reason) {
    res.status(403).json({ ok: false, error: result.reason } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: result } satisfies ApiResult<typeof result>)
})

xhsResearchRouter.delete('/xhs-research/:id', requireAuth, (req, res) => {
  const { userId } = authOf(res)
  res.json({ ok: true, data: { deleted: deleteResearch(userId, req.params.id) } } satisfies ApiResult<{ deleted: boolean }>)
})

xhsResearchRouter.delete('/xhs-research', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  res.json({ ok: true, data: { deleted: clearResearch(userId) } } satisfies ApiResult<{ deleted: number }>)
})
