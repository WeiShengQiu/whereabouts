import { db } from './db'
import { newId } from './crypto'
import type { GenerationEmit } from './generation'
import { EVIDENCE_SOURCE_LABELS, evidenceInputSchema } from '../../shared/types'
import type {
  CachePolicy,
  Evidence,
  EvidenceBundle,
  EvidenceInput,
  EvidenceMatrix,
  EvidenceSource,
  SourceState,
  SourceStatus,
} from '../../shared/types'

/**
 * 第三方口碑证据层。
 *
 * 设计约束：不绕过任何反爬措施。遇到 403/429/风控页面只熔断降级，不重试、不换 UA、不走代理池。
 * 官方 API 数据一律 cachePolicy=none（实时取用、不落库），只有开放数据集与用户录入可长期保存，
 * 这样既满足各平台「禁止缓存内容」的条款，也不会把不可控数据沉淀成事实。
 */

interface SourceDef {
  id: EvidenceSource
  /** .env 变量名前缀：EVIDENCE_<env>_ENABLED / _URL / _KEY */
  env: string
  requiresKey: boolean
  cachePolicy: CachePolicy
  cacheRule: string
  attribution: string
  docs: string
  deepLink: (query: string) => string
}

const enc = encodeURIComponent
const SOURCE_DEFS: SourceDef[] = [
  {
    id: 'xiaohongshu',
    env: 'XHS',
    requiresKey: true,
    cachePolicy: 'none',
    cacheRule: '开放平台数据仅限授权范围使用，实时取用不落库',
    attribution: '小红书开放平台（需企业资质）',
    docs: 'https://open.xiaohongshu.com',
    deepLink: (q) => `https://www.xiaohongshu.com/search_result?keyword=${enc(q)}`,
  },
  {
    id: 'mafengwo',
    env: 'MFW',
    requiresKey: true,
    cachePolicy: 'none',
    cacheRule: '游记与点评无公开 OpenAPI，需商务授权，实时取用不落库',
    attribution: '马蜂窝（商务授权）',
    docs: 'https://open.mafengwo.cn',
    deepLink: (q) => `https://www.mafengwo.cn/search/q.php?q=${enc(q)}`,
  },
  {
    id: 'google_places',
    env: 'GOOGLE',
    requiresKey: true,
    cachePolicy: 'none',
    cacheRule: 'Places 条款禁止缓存评分/评论（仅 place_id 可永久存），每次展示实时调用',
    attribution: 'Google Places API (New)',
    docs: 'https://developers.google.com/maps/documentation/places/web-service/policies',
    deepLink: (q) => `https://www.google.com/maps/search/?api=1&query=${enc(q)}`,
  },
  {
    id: 'tripadvisor',
    env: 'TRIPADVISOR',
    requiresKey: true,
    cachePolicy: 'none',
    cacheRule: 'Terra 条款禁止缓存内容（仅 location ID 可存），每店最多 5 条点评',
    attribution: 'Tripadvisor Terra / Content API',
    docs: 'https://docs.terra.tripadvisor.com',
    deepLink: (q) => `https://www.tripadvisor.com/Search?q=${enc(q)}`,
  },
  {
    id: 'amap',
    env: 'AMAP',
    requiresKey: true,
    cachePolicy: 'none',
    cacheRule: '高德协议禁止存储服务内部数据，实时取用不落库',
    attribution: '高德地图开放平台',
    docs: 'https://lbs.amap.com',
    deepLink: (q) => `https://www.amap.com/search?query=${enc(q)}`,
  },
  {
    id: 'open_dataset',
    env: '',
    requiresKey: false,
    cachePolicy: 'persistent',
    cacheRule: '开放许可数据（OSM / Overture / FSQ OS Places / 文旅开放数据）可长期保存，须保留来源',
    attribution: '开放数据集（ODbL / Apache 2.0 / 开放许可）',
    docs: 'https://overturemaps.org',
    deepLink: () => '',
  },
  {
    id: 'manual',
    env: '',
    requiresKey: false,
    cachePolicy: 'persistent',
    cacheRule: '用户自行录入或导入，永久保存，可信度由用户判断',
    attribution: '用户录入',
    docs: '',
    deepLink: () => '',
  },
]

/** 熔断状态放在内存即可：重启自动清空，避免把临时的风控状态持久化成事实 */
interface Circuit {
  until: number
  reason: string
}
const CIRCUIT_MS = 5 * 60_000
const circuits = new Map<EvidenceSource, Circuit>()

function activeCircuit(id: EvidenceSource): Circuit | null {
  const current = circuits.get(id)
  if (!current) return null
  if (current.until <= Date.now()) {
    circuits.delete(id)
    return null
  }
  return current
}

function tripCircuit(id: EvidenceSource, reason: string): void {
  circuits.set(id, { until: Date.now() + CIRCUIT_MS, reason })
}

/** 风控/限流与普通网络错误要分开：只有前者触发熔断，后者仅跳过本次 */
class AntiBotError extends Error {
  readonly antiBot = true
}

function providerConfig(def: SourceDef): { url: string; key: string } | null {
  if (!def.requiresKey) return null
  if (process.env[`EVIDENCE_${def.env}_ENABLED`] !== '1') return null
  const url = process.env[`EVIDENCE_${def.env}_URL`]?.trim() ?? ''
  const key = process.env[`EVIDENCE_${def.env}_KEY`]?.trim() ?? ''
  return url ? { url, key } : null
}

/**
 * 通用 HTTP provider：把各家响应归一化成 Evidence[]。
 * URL 模板支持 {name} / {city} 占位；返回数组或 {items|data|results|places} 数组均可。
 * 真实各家专有字段映射由合规网关在 URL 侧完成，避免把未经验证的 API 结构写死在代码里。
 * 出网通道走全局 fetch；部署环境设置 HTTPS_PROXY 并由 start.sh 打开 NODE_USE_ENV_PROXY 即可生效。
 */
async function fetchJson(url: string, key: string): Promise<unknown> {
  const headers: Record<string, string> = {
    'user-agent': 'TravelPlanner/1.0 (evidence lookup; low frequency)',
    accept: 'application/json',
  }
  if (key) headers.authorization = `Bearer ${key}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) })
  const raw = await response.text()
  if (
    response.status === 403 ||
    response.status === 429 ||
    /captcha|验证码|challenge|access denied|robot check/i.test(raw.slice(0, 500))
  ) {
    throw new AntiBotError(`HTTP ${response.status} 或风控校验页面`)
  }
  if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}：${raw.slice(0, 160)}`)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('数据源返回的不是合法 JSON')
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function asText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().slice(0, limit)
  return text || null
}

/** 只接受 http(s) 链接，杜绝 javascript: 之类的注入 */
function asUrl(value: unknown): string | null {
  const text = asText(value, 600)
  return text && /^https?:\/\//i.test(text) ? text : null
}

function toRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  for (const key of ['items', 'data', 'results', 'places']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[]
  }
  return []
}

function normalizeRemote(raw: unknown, def: SourceDef, poi: string): Evidence[] {
  const now = new Date().toISOString()
  return toRows(raw)
    .slice(0, 10)
    .map((item) => {
      const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const rawRating = asNumber(row.rating ?? row.score ?? row.value)
      const scale = asNumber(row.ratingScale ?? row.scale) ?? 5
      const divisor = scale > 5 ? scale : 5
      const rating = rawRating === null ? null : Math.round(Math.min(5, Math.max(0, (rawRating / divisor) * 5)) * 10) / 10
      return {
        id: newId(),
        poiName: poi,
        source: def.id,
        rating,
        ratingRaw: asText(row.ratingRaw, 40) ?? (rawRating === null ? null : `${rawRating}/${divisor}`),
        ratingScale: scale,
        reviewCount: asNumber(row.reviewCount ?? row.reviews ?? row.review_count),
        url: asUrl(row.url ?? row.link),
        snippet: asText(row.snippet ?? row.summary ?? row.text, 500),
        origin: 'api' as const,
        confidence: 'medium' as const,
        fetchedAt: now,
      } satisfies Evidence
    })
}

interface EvidenceRow {
  id: string
  poi_name: string
  source: string
  rating: number | null
  rating_raw: string | null
  rating_scale: number | null
  review_count: number | null
  url: string | null
  snippet: string | null
  origin: string
  confidence: string
  fetched_at: string
}

function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    poiName: row.poi_name,
    source: row.source as EvidenceSource,
    rating: row.rating,
    ratingRaw: row.rating_raw,
    ratingScale: row.rating_scale,
    reviewCount: row.review_count,
    url: row.url,
    snippet: row.snippet,
    origin: row.origin as Evidence['origin'],
    confidence: row.confidence as Evidence['confidence'],
    fetchedAt: row.fetched_at,
  }
}

export function poiKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function listEvidence(userId: string): Evidence[] {
  const rows = db
    .prepare('SELECT * FROM evidence_items WHERE user_id = ? ORDER BY fetched_at DESC LIMIT 500')
    .all(userId) as EvidenceRow[]
  return rows.map(toEvidence)
}

export function readLocalEvidence(userId: string, poi: string): Evidence[] {
  const rows = db
    .prepare('SELECT * FROM evidence_items WHERE user_id = ? AND poi_key = ? ORDER BY fetched_at DESC')
    .all(userId, poiKey(poi)) as EvidenceRow[]
  return rows.map(toEvidence)
}

export function addEvidence(userId: string, input: EvidenceInput): Evidence {
  const parsed = evidenceInputSchema.parse(input)
  const id = newId()
  const now = new Date().toISOString()
  const confidence: Evidence['confidence'] = parsed.origin === 'manual' ? 'low' : 'medium'
  db.prepare(
    `INSERT INTO evidence_items
      (id, user_id, poi_key, poi_name, source, rating, rating_raw, rating_scale, review_count, url, snippet, origin, confidence, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    poiKey(parsed.poiName),
    parsed.poiName.trim(),
    parsed.source,
    parsed.rating,
    parsed.ratingRaw || null,
    parsed.ratingScale,
    parsed.reviewCount,
    asUrl(parsed.url),
    parsed.snippet || null,
    parsed.origin,
    confidence,
    now,
  )
  return {
    id,
    poiName: parsed.poiName.trim(),
    source: parsed.source,
    rating: parsed.rating,
    ratingRaw: parsed.ratingRaw || null,
    ratingScale: parsed.ratingScale,
    reviewCount: parsed.reviewCount,
    url: asUrl(parsed.url),
    snippet: parsed.snippet || null,
    origin: parsed.origin,
    confidence,
    fetchedAt: now,
  }
}

export function deleteEvidence(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM evidence_items WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

/** 极简 CSV 解析：支持双引号包裹与转义的表头/字段，不引入依赖 */
function csvRows(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  row.push(cell)
  if (row.some((item) => item.trim() !== '')) rows.push(row)
  return rows
}

export function parseEvidenceCsv(text: string): EvidenceInput[] {
  const rows = csvRows(text)
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据')
  const header = rows[0].map((item) => item.trim().toLowerCase())
  const missing = ['poiname', 'source'].filter((name) => !header.includes(name))
  if (missing.length) throw new Error(`CSV 缺少必需列：${missing.join(', ')}`)
  const at = (row: string[], name: string): string => {
    const index = header.indexOf(name)
    return index >= 0 ? (row[index] ?? '').trim() : ''
  }
  const nullableNumber = (value: string): number | null => (value && Number.isFinite(Number(value)) ? Number(value) : null)
  return rows.slice(1)
    .filter((row) => row.some((item) => item.trim() !== ''))
    .slice(0, 200)
    .map((row, index) => {
      try {
        return evidenceInputSchema.parse({
          poiName: at(row, 'poiname'),
          source: at(row, 'source'),
          rating: nullableNumber(at(row, 'rating')),
          ratingRaw: at(row, 'ratingraw'),
          ratingScale: nullableNumber(at(row, 'ratingscale')),
          reviewCount: nullableNumber(at(row, 'reviewcount')),
          url: at(row, 'url'),
          snippet: at(row, 'snippet'),
          origin: 'import',
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`第 ${index + 2} 行数据不合法：${reason}`)
      }
    })
}

export function importEvidence(userId: string, text: string): { imported: number; inputs: EvidenceInput[] } {
  const inputs = parseEvidenceCsv(text)
  for (const input of inputs) addEvidence(userId, input)
  return { imported: inputs.length, inputs }
}

/** 数据源状态：未配置、被熔断、已启用但无数据都明确区分，前端据此显示「未获取」而不是伪造分数 */
export function getSourceStatuses(poi: string, city: string, items: Evidence[]): SourceStatus[] {
  const query = city ? `${poi} ${city}` : poi
  return SOURCE_DEFS.map((def) => {
    const itemCount = items.filter((item) => item.source === def.id).length
    const circuit = activeCircuit(def.id)
    const configured = providerConfig(def)
    let state: SourceState
    let reason: string
    if (circuit) {
      state = 'degraded'
      reason = `已熔断：${circuit.reason}；5 分钟后自动恢复，本次不重试，改用回源链接`
    } else if (!def.requiresKey) {
      state = itemCount ? 'ready' : 'empty'
      reason = def.cacheRule
    } else if (process.env[`EVIDENCE_${def.env}_ENABLED`] !== '1' || !configured) {
      state = 'no_key'
      reason = `未启用：需按 ${def.attribution} 取得授权，再设置 EVIDENCE_${def.env}_ENABLED=1 与 EVIDENCE_${def.env}_URL`
    } else {
      state = itemCount ? 'ready' : 'empty'
      reason = itemCount ? '已通过授权通道获取' : '通道已启用，但本次未返回该地点的数据'
    }
    if (state !== 'degraded' && state !== 'no_key' && !itemCount && def.requiresKey) {
      reason += '；本次显示「未获取」'
    }
    return {
      id: def.id,
      label: EVIDENCE_SOURCE_LABELS[def.id],
      state,
      reason,
      cachePolicy: def.cachePolicy,
      cacheRule: def.cacheRule,
      attribution: def.attribution,
      deepLink: def.deepLink(query),
      itemCount,
    }
  })
}

/** 逐地点取证：本地证据 + 已启用的授权通道，任何风控信号都只熔断降级，不硬刚 */
export async function collectEvidence(
  userId: string,
  pois: string[],
  city: string,
  emit: GenerationEmit,
): Promise<EvidenceBundle> {
  const collectedAt = new Date().toISOString()
  const degraded: string[] = []
  const matrices: EvidenceMatrix[] = []
  const uniquePois = [...new Set(pois.map((item) => item.trim()).filter(Boolean))].slice(0, 8)

  emit({ type: 'stage', stage: 'evidence', message: `正在核对 ${uniquePois.length} 个地点的第三方口碑数据`, current: 0, total: uniquePois.length })

  // 冷却期内的源每次生成都要明确告知用户，而不是静默跳过
  const cooling = SOURCE_DEFS.filter((def) => def.requiresKey && activeCircuit(def.id)).map((def) => def.id)
  if (cooling.length) {
    degraded.push(...cooling)
    emit({
      type: 'log',
      stage: 'evidence',
      message: `${cooling.map((id) => EVIDENCE_SOURCE_LABELS[id]).join('、')} 仍在熔断冷却中，本次直接降级为回源链接（不重试）`,
    })
  }

  for (let index = 0; index < uniquePois.length; index += 1) {
    const poi = uniquePois[index]
    const items = readLocalEvidence(userId, poi)
    for (const def of SOURCE_DEFS.filter((item) => item.requiresKey)) {
      const config = providerConfig(def)
      // 已熔断的源本次直接跳过；状态已在循环外统一记入 degraded 并推送事件
      if (activeCircuit(def.id) || !config) continue
      const url = config.url.replace('{name}', enc(poi)).replace('{city}', enc(city))
      try {
        const found = normalizeRemote(await fetchJson(url, config.key), def, poi)
        items.push(...found)
        if (found.length) {
          emit({ type: 'log', stage: 'evidence', message: `${EVIDENCE_SOURCE_LABELS[def.id]} 返回 ${found.length} 条「${poi}」评分` })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof AntiBotError) {
          tripCircuit(def.id, message)
          degraded.push(def.id)
          emit({
            type: 'log',
            stage: 'evidence',
            message: `${EVIDENCE_SOURCE_LABELS[def.id]} 触发风控或限流，已熔断并降级为回源链接（不重试）`,
            detail: message,
          })
        } else {
          emit({ type: 'log', stage: 'evidence', message: `${EVIDENCE_SOURCE_LABELS[def.id]} 本次不可用，已降级`, detail: message })
        }
      }
    }
    matrices.push({ poiName: poi, items, sources: getSourceStatuses(poi, city, items), collectedAt })
    emit({
      type: 'progress',
      stage: 'evidence',
      message: `「${poi}」取证完成：${items.length} 条证据，${items.length ? '可用于对比' : '全部源未获取'}`,
      current: index + 1,
      total: uniquePois.length,
    })
  }
  return { matrices, degraded: [...new Set(degraded)], collectedAt }
}

/**
 * 把证据压缩成注入 prompt 的文本。核心目的是约束模型：
 * 只能引用给定证据，禁止虚构评分，禁止跨平台求平均，必须标注来源与获取日期。
 */
export function evidencePrompt(bundle: EvidenceBundle | null): string {
  if (!bundle || bundle.matrices.length === 0) {
    return [
      '【第三方口碑数据】本次未获取到任何第三方评分。',
      '严格禁止写出任何具体评分、星级、「网友推荐」「评分 X 分」「口碑很好」等表述；',
      '涉及地点时只描述行程安排，并提示用户自行到官方或点评平台核实。',
    ].join('\n')
  }
  const blocks = bundle.matrices.map((matrix) => {
    const rows = matrix.items.length
      ? matrix.items
          .map((item) => {
            const score = item.rating !== null ? `${item.rating.toFixed(1)}/5（原始 ${item.ratingRaw ?? '—'}）` : '无评分'
            const count = item.reviewCount !== null ? `，评价数 ${item.reviewCount}` : ''
            const source = `，回源 ${item.url ?? '无链接'}`
            return `- ${EVIDENCE_SOURCE_LABELS[item.source]}：${score}${count}，获取于 ${item.fetchedAt.slice(0, 10)}${source}`
          })
          .join('\n')
      : '- 所有数据源均未获取到数据'
    const missing = matrix.sources.filter((source) => source.itemCount === 0).map((source) => source.label).join('、')
    return `【${matrix.poiName}】\n${rows}\n未获取：${missing || '无'}`
  })
  return [
    '【第三方口碑数据：由系统取证，非模型生成】',
    ...blocks,
    '',
    '严格约束：',
    '1. 只能引用上面列出的评分、评价数与来源；禁止编造任何未提供的评分、星级、点评内容或「网友评价」。',
    '2. 各平台评分口径不同，禁止计算跨平台平均分或伪造综合评分；同一地点评分不一致时明确指出分歧，并建议用户回源核实。',
    '3. 引用评分必须写明来源名与获取日期；未获取的源明确写「未获取」，不要用「普遍好评」等模糊说法替代。',
    '4. 口碑数据仅供参考，不替代官方开放时间、票价与预约信息。',
    bundle.degraded.length
      ? `5. 以下源本次因风控或限流被熔断，不要假设它们有数据：${bundle.degraded.map((id) => EVIDENCE_SOURCE_LABELS[id as EvidenceSource]).join('、')}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 只读矩阵：查本地已存证据与数据源状态，不向任何第三方发请求 */
export function buildLocalBundle(userId: string, pois: string[], city: string): EvidenceBundle {
  const collectedAt = new Date().toISOString()
  const uniquePois = [...new Set(pois.map((item) => item.trim()).filter(Boolean))].slice(0, 8)
  const matrices: EvidenceMatrix[] = uniquePois.map((poi) => {
    const items = readLocalEvidence(userId, poi)
    return { poiName: poi, items, sources: getSourceStatuses(poi, city, items), collectedAt }
  })
  return { matrices, degraded: [], collectedAt }
}

/** 供「数据源状态」页展示：只检查配置与运行环境，不向第三方发探测请求 */
export function probeSources(poi: string, city: string): SourceStatus[] {
  return getSourceStatuses(poi, city, [])
}

export function proxyHint(): string {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? ''
  if (!proxy) return '未配置出网代理；海外源如不可达，请由部署环境提供合规通道'
  return `已配置出网代理（${proxy.replace(/\/\/.*@/, '//***@')}）；NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY ?? '未设置'}`
}
