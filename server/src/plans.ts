import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { db, filesDir } from './db'
import { authOf, requireAuth } from './auth'
import { getConfig, getDefaultConfig, type LLMConfigRecord } from './llm'
import { generateGuide, generateOptions, type GenerationEmit } from './generation'
import { renderGuideHtml } from './html'
import { newId } from './crypto'
import { collectEvidence } from './evidence'
import { collectGeo, geoPrompt, withStaticImages } from './geo'
import { researchBundle, researchPrompt } from './xhs-research'
import type { ApiResult, EvidenceBundle, FileView, GenerationEvent, GeoBundle, PlanOption, PlanView, ResearchBundle, TravelGuide } from '../../shared/types'

type AsyncHandler = (req: Request, res: Response) => Promise<void>
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => {
  Promise.resolve(fn(req, res)).catch(next)
}

interface PlanRow {
  id: string
  user_id: string
  requirement: string
  config_id: string
  model: string
  options_json: string | null
  selected_index: number | null
  guide_json: string | null
  evidence_json: string | null
  geo_json: string | null
  research_json: string | null
  created_at: string
}

interface FileRow {
  id: string
  plan_id: string
  kind: string
  file_name: string
  size_bytes: number
  created_at: string
}

/** configId / model 允许为空：后端会回退到系统内置默认模型，保证新用户零配置即可生成 */
const createPlanSchema = z.object({
  requirement: z.string().trim().min(5, '请至少描述 5 个字的旅行需求').max(2000),
  configId: z.string().optional().default(''),
  model: z.string().optional().default(''),
})
const selectSchema = z.object({ optionIndex: z.number().int().min(0) })

function loadPlan(userId: string, id: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plans WHERE id = ? AND user_id = ?').get(id, userId) as PlanRow | undefined) ?? null
}

function toPlanView(row: PlanRow): PlanView {
  return {
    id: row.id,
    requirement: row.requirement,
    options: row.options_json ? (JSON.parse(row.options_json) as PlanOption[]) : null,
    selectedIndex: row.selected_index,
    guide: row.guide_json ? (JSON.parse(row.guide_json) as TravelGuide) : null,
    evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as EvidenceBundle) : null,
    geo: row.geo_json ? (JSON.parse(row.geo_json) as GeoBundle) : null,
    research: row.research_json ? (JSON.parse(row.research_json) as ResearchBundle) : null,
    createdAt: row.created_at,
  }
}

function toFileView(row: FileRow): FileView {
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }
}

/**
 * configId / model 为空时回退到系统内置默认模型；实际采用的值写入 plans 表，
 * 这样第二阶段 buildGuide 仍能用 getConfig(plan.config_id) 精确复现同一配置。
 */
function resolvePlanConfig(userId: string, configId: string, model: string): { config: LLMConfigRecord; configId: string; model: string } {
  const fallback = getDefaultConfig()
  const config = configId ? getConfig(userId, configId) : fallback
  if (!config) throw new Error('尚未配置模型服务：请在「模型设置」新增配置，或由管理员设置 DEFAULT_LLM_API_KEY')
  const resolvedModel = model.trim() || config.defaultModel || fallback?.defaultModel || ''
  if (!resolvedModel) throw new Error('请选择或填写模型名称')
  return { config, configId: config.id, model: resolvedModel }
}

/** 两阶段生成共用编排：JSON 接口传空 emit，SSE 接口把事件实时推给前端 */
async function createPlanWithOptions(
  userId: string,
  sessionId: string,
  input: z.infer<typeof createPlanSchema>,
  emit: GenerationEmit,
): Promise<PlanView> {
  const { config, configId, model } = resolvePlanConfig(userId, input.configId, input.model)
  const id = newId()
  db.prepare(
    `INSERT INTO plans (id, user_id, session_id, requirement, config_id, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, sessionId, input.requirement, configId, model, new Date().toISOString())
  try {
    // 用户实采的小红书线索：生成方案前读取快照并注入，让方案贴近真实笔记里的地点与玩法
    const research = researchBundle(userId)
    if (research.items.length) {
      emit({
        type: 'stage', stage: 'research',
        message: `正在结合你采集的 ${research.items.length} 条小红书线索生成方案（线索仅作参考，非评分）`,
        current: 0, total: 1,
      })
    }
    const { options, places, city } = await generateOptions(config, input.requirement, model, emit, researchPrompt(research))
    // 方案里的具体地点同时交给口碑证据层与地图定位层；一份数据贯穿指南生成、页面预览与 HTML 导出
    const bundle = await collectEvidence(userId, places, city, emit)
    const geo = await collectGeo(places, city, emit)
    db.prepare('UPDATE plans SET options_json = ?, evidence_json = ?, geo_json = ?, research_json = ? WHERE id = ?')
      .run(JSON.stringify(options), JSON.stringify(bundle), JSON.stringify(geo), JSON.stringify(research), id)
    return toPlanView(loadPlan(userId, id)!)
  } catch (error) {
    // 生成失败不留下空记录，避免历史里出现无法继续的半成品
    db.prepare('DELETE FROM plans WHERE id = ?').run(id)
    throw error
  }
}

async function buildGuide(userId: string, planId: string, emit: GenerationEmit): Promise<PlanView> {
  const plan = loadPlan(userId, planId)
  if (!plan) throw new Error('规划不存在')
  if (plan.selected_index === null || !plan.options_json) throw new Error('请先选择一个定制方案')
  const config = getConfig(userId, plan.config_id)
  if (!config) throw new Error('原模型配置已被删除，无法继续生成')
  const options = JSON.parse(plan.options_json) as PlanOption[]
  const selected = options[plan.selected_index]
  const geo = plan.geo_json ? (JSON.parse(plan.geo_json) as GeoBundle) : null
  // 用规划生成时的线索快照，历史记录可复现，不受之后新增/删除线索影响
  const research = plan.research_json ? (JSON.parse(plan.research_json) as ResearchBundle) : null
  if (research?.items.length) {
    emit({
      type: 'stage', stage: 'research',
      message: `正在结合 ${research.items.length} 条小红书实采线索优化指南（参考地点与玩法，不生成评分）`,
      current: 0, total: 1,
    })
  }
  const guide = await generateGuide(config, plan.requirement, selected, plan.model, emit, {
    // 第三方口碑评分来源混乱、多数未取到：不再注入模型，指南不写任何评分
    geo: geoPrompt(geo),
    research: researchPrompt(research),
    places: geo?.pois.map((poi) => poi.name) ?? [],
  })
  db.prepare('UPDATE plans SET guide_json = ? WHERE id = ?').run(JSON.stringify(guide), plan.id)
  return toPlanView(loadPlan(userId, plan.id)!)
}

interface StreamChannel {
  emit: GenerationEmit
  done: (result: PlanView) => void
  fail: (error: unknown) => void
  close: () => void
}

/** 单请求即流：POST 直接返回 text/event-stream，无需额外的任务注册表 */
function openStream(res: Response): StreamChannel {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const startedAt = Date.now()
  const write = (event: Omit<GenerationEvent, 'elapsedMs'>) => {
    if (res.writableEnded) return
    const payload: GenerationEvent = { ...event, elapsedMs: Date.now() - startedAt }
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // 客户端提前关闭页面，后续事件直接丢弃即可
    }
  }
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': ping\n\n')
      } catch {
        // 连接已关闭，close 事件会清理定时器
      }
    }
  }, 15_000)
  res.on('close', () => clearInterval(heartbeat))
  return {
    emit: write,
    done: (result) => write({ type: 'done', stage: 'done', message: '生成完成', result }),
    fail: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      write({ type: 'error', stage: 'error', message, detail: message })
    },
    close: () => {
      clearInterval(heartbeat)
      res.end()
    },
  }
}

export const plansRouter = Router()

plansRouter.get('/plans', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  const rows = db.prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) as PlanRow[]
  res.json({ ok: true, data: rows.map(toPlanView) } satisfies ApiResult<PlanView[]>)
})

plansRouter.get('/plans/:id', requireAuth, (req, res) => {
  const { userId } = authOf(res)
  const plan = loadPlan(userId, req.params.id)
  if (!plan) {
    res.status(404).json({ ok: false, error: '规划不存在' } satisfies ApiResult<never>)
    return
  }
  res.json({ ok: true, data: toPlanView(plan) } satisfies ApiResult<PlanView>)
})

/** 第一阶段（同步 JSON，保留原接口契约） */
plansRouter.post('/plans', requireAuth, wrap(async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0].message } satisfies ApiResult<never>)
    return
  }
  const { userId, sessionId } = authOf(res)
  const view = await createPlanWithOptions(userId, sessionId, parsed.data, () => {})
  res.json({ ok: true, data: view } satisfies ApiResult<PlanView>)
}))

/** 第一阶段（SSE 实时进度） */
plansRouter.post('/plans/stream', requireAuth, wrap(async (req, res) => {
  const channel = openStream(res)
  try {
    const parsed = createPlanSchema.safeParse(req.body)
    if (!parsed.success) throw new Error(parsed.error.issues[0].message)
    const { userId, sessionId } = authOf(res)
    channel.done(await createPlanWithOptions(userId, sessionId, parsed.data, channel.emit))
  } catch (error) {
    channel.fail(error)
  } finally {
    channel.close()
  }
}))

plansRouter.post('/plans/:id/select', requireAuth, (req, res) => {
  const parsed = selectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: '请选择有效的方案' } satisfies ApiResult<never>)
    return
  }
  const { userId } = authOf(res)
  const plan = loadPlan(userId, req.params.id)
  if (!plan) {
    res.status(404).json({ ok: false, error: '规划不存在' } satisfies ApiResult<never>)
    return
  }
  const options: PlanOption[] = plan.options_json ? JSON.parse(plan.options_json) : []
  if (parsed.data.optionIndex >= options.length) {
    res.status(400).json({ ok: false, error: '方案序号超出范围' } satisfies ApiResult<never>)
    return
  }
  db.prepare('UPDATE plans SET selected_index = ?, guide_json = NULL WHERE id = ?').run(parsed.data.optionIndex, plan.id)
  res.json({ ok: true, data: toPlanView(loadPlan(userId, plan.id)!) } satisfies ApiResult<PlanView>)
})

/** 第二阶段（同步 JSON，保留原接口契约） */
plansRouter.post('/plans/:id/guide', requireAuth, wrap(async (req, res) => {
  const { userId } = authOf(res)
  const view = await buildGuide(userId, req.params.id, () => {})
  res.json({ ok: true, data: { ...view, attempts: 1 } } satisfies ApiResult<PlanView & { attempts: number }>)
}))

/** 第二阶段（SSE 实时进度）：逐块生成 + 逐阶段回推 */
plansRouter.post('/plans/:id/guide/stream', requireAuth, wrap(async (req, res) => {
  const channel = openStream(res)
  try {
    channel.done(await buildGuide(authOf(res).userId, req.params.id, channel.emit))
  } catch (error) {
    channel.fail(error)
  } finally {
    channel.close()
  }
}))

/** 导出 HTML：UUID 文件名 + 落盘 + 写入文件生成记录 */
plansRouter.post('/plans/:id/export', requireAuth, wrap(async (req, res) => {
  const { userId } = authOf(res)
  const plan = loadPlan(userId, req.params.id)
  if (!plan) {
    res.status(404).json({ ok: false, error: '规划不存在' } satisfies ApiResult<never>)
    return
  }
  if (!plan.guide_json) {
    res.status(400).json({ ok: false, error: '请先生成旅游指南' } satisfies ApiResult<never>)
    return
  }
  const guide = JSON.parse(plan.guide_json) as TravelGuide
  const geo = plan.geo_json ? (JSON.parse(plan.geo_json) as GeoBundle) : null
  const research = plan.research_json ? (JSON.parse(plan.research_json) as ResearchBundle) : null
  // 静态地图只在导出时实时取用并内嵌，不写入数据库，也不会把密钥带进 HTML
  const html = renderGuideHtml(guide, plan.requirement, await withStaticImages(geo), research)
  const fileName = `${newId()}.html`
  const filePath = path.join(filesDir, fileName)
  fs.writeFileSync(filePath, html, 'utf8')

  const id = newId()
  const createdAt = new Date().toISOString()
  const sizeBytes = Buffer.byteLength(html, 'utf8')
  db.prepare(
    `INSERT INTO generated_files (id, user_id, plan_id, kind, file_name, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, plan.id, 'html', fileName, sizeBytes, createdAt)
  res.json({ ok: true, data: toFileView({ id, plan_id: plan.id, kind: 'html', file_name: fileName, size_bytes: sizeBytes, created_at: createdAt }) } satisfies ApiResult<FileView>)
}))

plansRouter.get('/files', requireAuth, (_req, res) => {
  const { userId } = authOf(res)
  const rows = db.prepare('SELECT * FROM generated_files WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as FileRow[]
  res.json({ ok: true, data: rows.map(toFileView) } satisfies ApiResult<FileView[]>)
})

plansRouter.get('/files/:id/download', requireAuth, (req, res) => {
  const { userId } = authOf(res)
  const row = db.prepare('SELECT * FROM generated_files WHERE id = ? AND user_id = ?').get(req.params.id, userId) as FileRow | undefined
  if (!row) {
    res.status(404).json({ ok: false, error: '文件记录不存在' } satisfies ApiResult<never>)
    return
  }
  // 双重校验：文件名必须是 UUID.html，杜绝目录穿越
  if (!/^[0-9a-f-]{36}\.html$/.test(row.file_name)) {
    res.status(500).json({ ok: false, error: '文件名异常，已拒绝读取' } satisfies ApiResult<never>)
    return
  }
  const filePath = path.join(filesDir, row.file_name)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ ok: false, error: '文件已丢失，请重新导出' } satisfies ApiResult<never>)
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="travel-guide-${row.id.slice(0, 8)}.html"`)
  res.sendFile(filePath)
})
