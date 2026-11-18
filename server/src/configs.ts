import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { authOf, requireAuth } from './auth'
import { createConfig, deleteConfig, getConfig, listConfigs, listModels, testConnection, updateConfig } from './llm'
import { DEFAULT_CONFIG_ID, llmConfigInputSchema, llmConfigUpdateSchema } from '../../shared/types'
import type { ApiResult, LLMConfigView } from '../../shared/types'

type AsyncHandler = (req: Request, res: Response) => Promise<void>
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => {
  Promise.resolve(fn(req, res)).catch(next)
}

const testSchema = z.object({ model: z.string().min(1, '请填写要测试的模型名') })

export const configsRouter = Router()

configsRouter.get('/', requireAuth, (_req, res) => {
  res.json({ ok: true, data: listConfigs(authOf(res).userId) } satisfies ApiResult<LLMConfigView[]>)
})

configsRouter.post('/', requireAuth, (req, res) => {
  const parsed = llmConfigInputSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: createConfig(authOf(res).userId, parsed.data) } satisfies ApiResult<LLMConfigView>)
})

configsRouter.put('/:id', requireAuth, (req, res) => {
  if (req.params.id === DEFAULT_CONFIG_ID) {
    res.status(400).json({ ok: false, error: '系统默认配置由服务器 .env 维护，不可修改' } satisfies ApiResult<never>)
    return
  }
  const parsed = llmConfigUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const view = updateConfig(authOf(res).userId, req.params.id, parsed.data)
  if (!view) {
    res.status(404).json({ ok: false, error: '配置不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: view } satisfies ApiResult<LLMConfigView>)
})

configsRouter.delete('/:id', requireAuth, (req, res) => {
  if (req.params.id === DEFAULT_CONFIG_ID) {
    res.status(400).json({ ok: false, error: '系统默认配置不可删除' } satisfies ApiResult<never>)
    return
  }
  if (!deleteConfig(authOf(res).userId, req.params.id)) {
    res.status(404).json({ ok: false, error: '配置不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: { deleted: true } } satisfies ApiResult<{ deleted: boolean }>)
})

/** 获取模型列表；端点不支持时返回 manualOnly=true，由前端切换为手动填写 */
configsRouter.get('/:id/models', requireAuth, wrap(async (req, res) => {
  const config = getConfig(authOf(res).userId, req.params.id)
  if (!config) {
    res.status(404).json({ ok: false, error: '配置不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: await listModels(config) })
}))

configsRouter.post('/:id/test', requireAuth, wrap(async (req, res) => {
  const parsed = testSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const config = getConfig(authOf(res).userId, req.params.id)
  if (!config) {
    res.status(404).json({ ok: false, error: '配置不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: await testConnection(config, parsed.data.model) })
}))
