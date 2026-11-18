import { z } from 'zod'

export const PROTOCOLS = ['chat_completions', 'responses', 'anthropic_messages'] as const
export type Protocol = (typeof PROTOCOLS)[number]

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  chat_completions: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  anthropic_messages: 'Anthropic Messages',
}

/** 系统内置默认模型的虚拟 ID：不落库，由服务端 .env 注入，前后端共享此标识 */
export const DEFAULT_CONFIG_ID = '__default__'

export const modelInfoSchema = z.object({
  id: z.string(),
  ownedBy: z.string().optional(),
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

export const llmConfigInputSchema = z.object({
  name: z.string().min(1, '请填写配置名称').max(50),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.string().url('请填写完整的 URL，例如 https://api.openai.com/v1'),
  apiKey: z.string().min(1, '请填写 API Key'),
  defaultModel: z.string().optional().default(''),
})
export type LLMConfigInput = z.infer<typeof llmConfigInputSchema>

/** 编辑时 apiKey 留空表示沿用已保存的密钥，接口永不回显明文 */
export const llmConfigUpdateSchema = llmConfigInputSchema.omit({ apiKey: true }).extend({
  apiKey: z.string().optional().default(''),
})
export type LLMConfigUpdate = z.infer<typeof llmConfigUpdateSchema>

export interface LLMConfigView {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  hasApiKey: boolean
  defaultModel: string
  createdAt: string
}

/** 第一阶段：供用户挑选的定制化方案 */
export const planOptionSchema = z.object({
  title: z.string(),
  theme: z.string(),
  days: z.string(),
  budget: z.string(),
  pace: z.string(),
  highlights: z.array(z.string()),
  summary: z.string(),
  suitableFor: z.string(),
})
export type PlanOption = z.infer<typeof planOptionSchema>

export const planOptionsSchema = z.object({
  options: z.array(planOptionSchema).min(2).max(5),
  /** 方案中涉及的具体地点；不卡数组长度，由服务端截断到 8 个，避免模型多列一个地点就整轮重试失败 */
  places: z.array(z.string().max(60)).optional().default([]),
  /** 目的地城市中文名，用于地图 POI 检索限定城市；兼容旧输出 */
  city: z.string().max(40).optional().default(''),
})

/** 第二阶段：完整的旅游指南 */
export const guideDaySchema = z.object({
  day: z.string(),
  title: z.string(),
  morning: z.string(),
  afternoon: z.string(),
  evening: z.string(),
  meals: z.string(),
  transport: z.string(),
  tips: z.string(),
})
export type GuideDay = z.infer<typeof guideDaySchema>

/** 地点图册：一地一卡的图文内容，name 用于和地图定位证据做匹配 */
export const guideSpotSchema = z.object({
  name: z.string(),
  category: z.string(),
  day: z.string(),
  time: z.string(),
  stay: z.string(),
  intro: z.string(),
  highlights: z.array(z.string()),
  tips: z.string(),
  photo: z.string(),
  cost: z.string(),
})
export type GuideSpot = z.infer<typeof guideSpotSchema>

export const travelGuideSchema = z.object({
  title: z.string(),
  destination: z.string(),
  duration: z.string(),
  overview: z.string(),
  days: z.array(guideDaySchema),
  budget: z.object({
    level: z.string(),
    items: z.array(z.string()),
    total: z.string(),
  }),
  packing: z.array(z.string()),
  notes: z.array(z.string()),
  /** 兼容旧指南：历史记录没有图册，解析时补空数组 */
  spots: z.array(guideSpotSchema).max(16).optional().default([]),
})
export type TravelGuide = z.infer<typeof travelGuideSchema>

/** ── 地图定位证据 ────────────────────────────────────────────── */
export const GEO_PROVIDERS = ['amap', 'google'] as const
export type GeoProvider = (typeof GEO_PROVIDERS)[number]

export const GEO_PROVIDER_LABELS: Record<GeoProvider, string> = {
  amap: '高德地图',
  google: 'Google Maps',
}

export interface GeoPoi {
  name: string
  city: string
  /** WGS-84 坐标，供 Google Maps 与路线示意图使用；未取到精确点位时为 null */
  lng: number | null
  lat: number | null
  /** 高德原始 GCJ-02 坐标，只用于高德深链，避免国内偏移 */
  gcjLng: number | null
  gcjLat: number | null
  address: string | null
  poiId: string | null
  provider: GeoProvider | null
  accuracy: 'exact' | 'link-only'
  /** 官方静态地图图片，已转成 data URI 内嵌；null 时用自绘 SVG 示意图 */
  staticImage: string | null
  amapLink: string
  googleLink: string
  note: string
}

export interface GeoBundle {
  city: string
  pois: GeoPoi[]
  /** 实际启用的精确定位提供者；null 表示仅生成官方深链 */
  provider: GeoProvider | null
  providerLabel: string
  degraded: string[]
  /** 坐标系、图片来源与署名说明，直接随指南展示 */
  attribution: string
  collectedAt: string
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface UserView {
  id: string
  email: string
  createdAt: string
}

export interface SessionView {
  id: string
  userAgent: string
  ip: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  current: boolean
}

export interface PlanView {
  id: string
  requirement: string
  options: PlanOption[] | null
  selectedIndex: number | null
  guide: TravelGuide | null
  /** 第一阶段取证得到的第三方口碑矩阵，指南生成与 HTML 导出都基于同一份证据 */
  evidence: EvidenceBundle | null
  /** 同一批地点的地图定位证据，指南图文卡与导出 HTML 共用 */
  geo: GeoBundle | null
  /** 生成时消费的小红书实采线索快照，历史规划可复现 */
  research: ResearchBundle | null
  createdAt: string
}

export interface FileView {
  id: string
  planId: string
  kind: string
  fileName: string
  sizeBytes: number
  createdAt: string
}

/** 生成过程的实时事件，由后端 SSE 推送，前端逐条渲染成任务时间线 */
export type GenerationEventType = 'stage' | 'progress' | 'retry' | 'log' | 'error' | 'done'
export interface GenerationEvent {
  type: GenerationEventType
  stage: string
  message: string
  elapsedMs: number
  current?: number
  total?: number
  attempt?: number
  /** 上游原文、解析失败片段等，仅前端可折叠展示，不主动弹给用户 */
  detail?: string
  result?: PlanView
}

/** 第三方口碑数据源。零密钥时仅 manual / open_dataset 与回源深链可用 */
export const EVIDENCE_SOURCES = ['xiaohongshu', 'mafengwo', 'google_places', 'tripadvisor', 'amap', 'open_dataset', 'manual'] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSource, string> = {
  xiaohongshu: '小红书',
  mafengwo: '马蜂窝',
  google_places: 'Google Maps',
  tripadvisor: '猫途鹰',
  amap: '高德地图',
  open_dataset: '开放数据集',
  manual: '手动录入',
}

/** 条款允许的留存策略：none 表示实时取用不落库，persistent 表示可长期保存 */
export type CachePolicy = 'none' | 'id-only' | 'short' | 'persistent'
export type SourceState = 'ready' | 'no_key' | 'disabled' | 'degraded' | 'empty'

export interface SourceStatus {
  id: EvidenceSource
  label: string
  state: SourceState
  reason: string
  cachePolicy: CachePolicy
  cacheRule: string
  attribution: string
  deepLink: string
  itemCount: number
}

export interface Evidence {
  id: string
  poiName: string
  source: EvidenceSource
  /** 归一化到 0–5；null 表示该源只提供了点评数/链接而没有评分 */
  rating: number | null
  ratingRaw: string | null
  ratingScale: number | null
  reviewCount: number | null
  url: string | null
  snippet: string | null
  origin: 'api' | 'dataset' | 'manual' | 'import'
  confidence: 'high' | 'medium' | 'low'
  fetchedAt: string
}

export interface EvidenceMatrix {
  poiName: string
  items: Evidence[]
  sources: SourceStatus[]
  collectedAt: string
}

export interface EvidenceBundle {
  matrices: EvidenceMatrix[]
  /** 因 403/429/风控或网络不可达而被熔断降级的源 */
  degraded: string[]
  collectedAt: string
}

/** ── 小红书笔记检索（独立研究通道，默认关闭）─────────────────────
 * 只传递检索结果的元数据与回源链接，不含正文、图片与评分；
 * 通道由部署者自行决定是否启用，主服务不实现任何签名或反爬逻辑。 */
export interface XhsNote {
  id: string
  title: string
  author: string
  likes: number | null
  collects: number | null
  comments: number | null
  noteType: string
  url: string
  fetchedAt: string
}

export interface XhsSearchResult {
  query: string
  count: number
  items: XhsNote[]
  /** live = 通道返回真实结果；disabled = 未启用；degraded = 风控/故障已降级为官方搜索入口 */
  mode: 'live' | 'disabled' | 'degraded'
  notice: string
  deepLink: string
}

export interface XhsChannelStatus {
  enabled: boolean
  ready: boolean
  reason: string
  minInterval: number | null
  maxLimit: number | null
  deepLink: string
  compliance: string
}

export const evidenceInputSchema = z.object({
  poiName: z.string().trim().min(1, '请填写地点名称').max(120),
  source: z.enum(EVIDENCE_SOURCES),
  rating: z.number().min(0).max(5).nullable().optional().default(null),
  ratingRaw: z.string().max(40).optional().default(''),
  ratingScale: z.number().min(1).max(100).nullable().optional().default(null),
  reviewCount: z.number().int().min(0).nullable().optional().default(null),
  url: z.string().max(600).optional().default(''),
  snippet: z.string().max(600).optional().default(''),
  origin: z.enum(['dataset', 'manual', 'import']).optional().default('manual'),
})
export type EvidenceInput = z.infer<typeof evidenceInputSchema>

// ── 小红书实采研究线索 ──────────────────────────────────────────────
// 与「口碑评分证据」严格分离：这里是用户在自己浏览器用扩展采集的笔记线索，
// 只携带标题/作者/摘要/互动数/链接，无评分；注入模型时明确标注来源与免责声明。

/** 四类旅行信息，与小红书检索方向一一对应 */
export const RESEARCH_CATEGORIES = ['hotel', 'transport', 'food', 'attraction'] as const
export type ResearchCategory = (typeof RESEARCH_CATEGORIES)[number]

export const RESEARCH_CATEGORY_LABELS: Record<ResearchCategory, string> = {
  hotel: '酒店住宿',
  transport: '交通出行',
  food: '饮食美食',
  attraction: '景点玩乐',
}

/** 一条分类检索词（模型按需求生成，用户可点深链去小红书搜） */
export const researchQuerySchema = z.object({
  category: z.enum(RESEARCH_CATEGORIES),
  keyword: z.string().trim().min(1).max(80),
})
export type ResearchQuery = z.infer<typeof researchQuerySchema>

export const researchQueriesSchema = z.object({
  queries: z.array(researchQuerySchema).min(1).max(20),
})

/** 一条实采笔记线索（来自扩展导出的 JSON，经白名单与凭证校验） */
export const researchItemSchema = z.object({
  id: z.string().default(''),
  category: z.enum(RESEARCH_CATEGORIES),
  keyword: z.string().trim().max(80).default(''),
  title: z.string().trim().max(200).default(''),
  author: z.string().trim().max(80).default(''),
  summary: z.string().trim().max(500).default(''),
  likes: z.number().int().min(0).nullable().default(null),
  url: z.string().trim().max(600),
  collectedAt: z.string().max(40).default(''),
})
export type ResearchItem = z.infer<typeof researchItemSchema>

/** 导入扩展 JSON 的请求体：带登录凭证，未登录/未装扩展的采集一律拒绝 */
export const researchImportSchema = z.object({
  category: z.enum(RESEARCH_CATEGORIES),
  keyword: z.string().trim().max(80).default(''),
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
    })),
  }),
})
export type ResearchImport = z.infer<typeof researchImportSchema>

export interface ResearchBundle {
  items: ResearchItem[]
  collectedAt: string
}

/** 平台页检测扩展安装：扩展注入的全局标记 */
export interface XhsCollectorStatus {
  installed: boolean
  version: string
  /** 扩展上报的最近一次小红书登录态（可能为 null：扩展未采集过） */
  lastLoginState: boolean | null
}
