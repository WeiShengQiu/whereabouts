/** 小红书实采研究的 HTTP 路由：检索词生成、采集批次、线索导入、封面代理 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { authOf, requireAuth } from './auth'
import { getConfig, getDefaultConfig } from './llm'
import {
  clearResearch,
  createRun,
  deleteResearch,
  generateResearchQueries,
  importResearch,
  latestRun,
  listResearch,
  listRuns,
  RESEARCH_RUN_KEEP,
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

const runSchema = z.object({
  requirement: z.string().trim().max(2000).optional().default(''),
})

// 导入体在 shared/types 里有 researchImportSchema，这里只补充路由层的字段约束
const importSchema = z.object({
  /** 采集批次：一次提问对应一个批次，缺省时落到最近一批（手动粘贴兜底） */
  runId: z.string().trim().max(60).optional().default(''),
  requirement: z.string().trim().max(2000).optional().default(''),
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
      cover: z.string().optional().default(''),
      link: z.string().optional().default(''),
    })).max(60),
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

/** 新开一次采集批次（一次提问 = 一批），返回批次 id 供导入时回传 */
xhsResearchRouter.post('/xhs-research/runs', requireAuth, (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  const id = createRun(userId, parsed.data.requirement)
  res.json({ ok: true, data: { id } } satisfies ApiResult<{ id: string }>)
})

/** 批次概览：只给次数与条数，不回传线索正文（前端不再展示已采集线索） */
xhsResearchRouter.get('/xhs-research/summary', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  const runs = listRuns(userId)
  const total = runs.reduce((sum, run) => sum + run.itemCount, 0)
  res.json({
    ok: true,
    data: { runs, total, keep: RESEARCH_RUN_KEEP, latestRunId: latestRun(userId)?.id ?? '' },
  } satisfies ApiResult<{ runs: ReturnType<typeof listRuns>; total: number; keep: number; latestRunId: string }>)
})

/** 读取最近一批线索（兼容旧调用；前端常规路径只读 summary） */
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
  const { category, keyword, payload, requirement } = parsed.data
  // 没有 runId（手动粘贴兜底）时：优先落到最近一批，没有批次则现场建一个
  const runId = parsed.data.runId || latestRun(userId)?.id || createRun(userId, requirement)
  const result = importResearch(userId, runId, category, keyword, payload)
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
