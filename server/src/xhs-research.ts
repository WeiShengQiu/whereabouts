/**
 * 小红书实采研究层。
 *
 * 职责：
 * 1. 把旅行需求拆成「酒店 / 交通 / 饮食 / 景点」四类检索词（模型生成 + 规则兜底）；
 * 2. 接收用户在自己浏览器用扩展采集并主动导入的笔记线索——强制「已登录小红书」凭证校验、
 *    域名白名单、去重，落库为无评分线索；
 * 3. 生成注入模型的 researchPrompt：把线索明确标注为「用户实采、非评分、需回源核实」，
 *    约束模型只把它们当参考，不得据此编造评分或把点赞数当口碑分。
 *
 * 合规边界：本文件不访问小红书、不解析签名、不代抓，数据全部来自用户主动导入。
 */
import { db } from './db'
import { newId } from './crypto'
import { chatStructured } from './structured'
import type { LLMConfigRecord } from './llm'
import type { StructuredEmit } from './structured'
import {
  RESEARCH_CATEGORY_LABELS,
  researchQueriesSchema,
  researchItemSchema,
} from '../../shared/types'
import type { ResearchBundle, ResearchCategory, ResearchItem, ResearchQuery } from '../../shared/types'

/** 用户消息里的链接只放行小红书官方域名，杜绝把任意外链写进线索 */
function safeNoteUrl(raw: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw, 'https://www.xiaohongshu.com')
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'www.xiaohongshu.com' && url.hostname !== 'xiaohongshu.com') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

const QUERY_SYSTEM = `你是旅行规划助手。根据用户旅行需求，输出四类是小红书检索关键词，用于用户在小红书搜索真实笔记。
只输出一个 JSON 对象，结构为：
{"queries":[{"category":"hotel","keyword":"关键词"},{"category":"transport","keyword":"关键词"},{"category":"food","keyword":"关键词"},{"category":"attraction","keyword":"关键词"}]}
四类 category 固定为 hotel（酒店住宿）、transport（交通出行）、food（饮食美食）、attraction（景点玩乐）；每类给 1–2 个最贴需求的中文关键词，关键词要具体（含城市/区域/场景），例如「成都 春熙路 设计酒店」「成都 地铁 三日交通」。
全部中文，不要解释文字或 Markdown 围栏。`

/** 模型不可用时用规则兜底：从需求里提取城市，套用四类通用关键词，保证流程不断 */
function ruleBasedQueries(requirement: string): ResearchQuery[] {
  // 提取城市：优先「去/到/在 + 城市」，再匹配「XX市 / XX及周边 / XX4天」；
  // 去掉「玩/旅游/及周边/三日」等常见后缀，避免把整句话当城市名
  const noiseSuffix = /(及周边|附近|[一二三四五六七八九十两\d]+天游|[一二三四五六七八九十两\d]+天|[一二三四五六七八九十两]+日游|天游|旅游|游玩|玩|市)$/
  const extractCity = (raw: string): string => {
    let c = raw.trim()
    for (let i = 0; i < 3; i++) {
      const trimmed = c.replace(noiseSuffix, '')
      if (trimmed === c) break
      c = trimmed
    }
    return c.length >= 2 ? c : ''
  }
  const cityMatch = /(?:去|到|在)([\u4e00-\u9fa5]{2,8})/.exec(requirement)
    || /([\u4e00-\u9fa5]{2,8}?)(?:及周边|三日游|三日|二日|一日|\d+\s*天|天游|市)/.exec(requirement)
  const city = (cityMatch && extractCity(cityMatch[1])) || '目的地'
  const seeds: Array<[ResearchCategory, string]> = [
    ['hotel', `${city} 住宿 酒店 推荐`],
    ['transport', `${city} 交通 出行 攻略`],
    ['food', `${city} 美食 小吃 推荐`],
    ['attraction', `${city} 景点 打卡 攻略`],
  ]
  return seeds.map(([category, keyword]) => ({ category, keyword }))
}

/** 分类检索词：优先模型，失败降级规则，永不因模型不可用阻塞用户 */
export async function generateResearchQueries(
  config: LLMConfigRecord | null,
  requirement: string,
  model: string,
  emit?: StructuredEmit,
): Promise<{ queries: ResearchQuery[]; source: 'model' | 'rule' }> {
  if (config) {
    try {
      const { value } = await chatStructured(
        config,
        {
          model,
          messages: [
            { role: 'system', content: QUERY_SYSTEM },
            { role: 'user', content: `旅行需求：${requirement}` },
          ],
          temperature: 0.5,
          maxTokens: 800,
        },
        researchQueriesSchema,
        emit ? { emit } : undefined,
      )
      // 每类最多保留 2 个，补全缺失类别
      const byCategory = new Map<ResearchCategory, ResearchQuery[]>()
      for (const query of value.queries) {
        const list = byCategory.get(query.category) ?? []
        if (list.length < 2 && query.keyword) list.push({ category: query.category, keyword: query.keyword })
        byCategory.set(query.category, list)
      }
      const filled = (['hotel', 'transport', 'food', 'attraction'] as ResearchCategory[]).flatMap((category) =>
        byCategory.get(category)?.length
          ? byCategory.get(category)!
          : ruleBasedQueries(requirement).filter((item) => item.category === category),
      )
      return { queries: filled.slice(0, 12), source: 'model' }
    } catch {
      // 结构化生成失败不阻断检索流程，降级规则关键词
    }
  }
  return { queries: ruleBasedQueries(requirement), source: 'rule' }
}

interface ResearchRow {
  id: string
  user_id: string
  category: string
  keyword: string
  title: string
  author: string
  summary: string
  likes: number | null
  url: string
  collected_at: string
  created_at: string
}

function toItem(row: ResearchRow): ResearchItem {
  return researchItemSchema.parse({
    id: row.id,
    category: row.category,
    keyword: row.keyword,
    title: row.title,
    author: row.author,
    summary: row.summary,
    likes: row.likes,
    url: row.url,
    collectedAt: row.collected_at,
  })
}

/** 读取用户全部实采线索，按采集时间倒序 */
export function listResearch(userId: string): ResearchItem[] {
  const rows = db
    .prepare('SELECT * FROM xhs_research WHERE user_id = ? ORDER BY collected_at DESC, created_at DESC LIMIT 200')
    .all(userId) as ResearchRow[]
  return rows.map(toItem)
}

/** 生成时消费的线索快照：最多 30 条，避免 prompt 过长 */
export function researchBundle(userId: string): ResearchBundle {
  const items = listResearch(userId).slice(0, 30)
  return { items, collectedAt: new Date().toISOString() }
}

/**
 * 导入扩展采集结果。
 * 硬门禁：payload.loginChecked && payload.loggedIn 必须为 true——即扩展确认用户已登录小红书。
 * 未登录 / 未装扩展（无法产生带凭证的 JSON）的采集一律拒绝。
 */
export function importResearch(
  userId: string,
  category: ResearchCategory,
  keyword: string,
  payload: {
    loginChecked?: boolean
    loggedIn?: boolean
    extensionVersion?: string
    collectedAt?: string
    items: Array<{ title?: string; author?: string; likes?: number | null; summary?: string; link?: string }>
  },
): { imported: number; skipped: number; reason?: string } {
  if (!payload.loginChecked || !payload.loggedIn) {
    return { imported: 0, skipped: 0, reason: '采集凭证无效：请确认已安装扩展并登录小红书后重新采集' }
  }
  let imported = 0
  let skipped = 0
  const collectedAt = payload.collectedAt || new Date().toISOString()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO xhs_research
      (id, user_id, category, keyword, title, author, summary, likes, url, collected_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const raw of payload.items) {
    const url = safeNoteUrl(raw.link ?? '')
    if (!url) { skipped++; continue }
    const likes = typeof raw.likes === 'number' && Number.isFinite(raw.likes) && raw.likes >= 0
      ? Math.floor(raw.likes) : null
    const result = insert.run(
      newId(), userId, category, keyword.slice(0, 80),
      (raw.title ?? '').trim().slice(0, 200),
      (raw.author ?? '').trim().slice(0, 80),
      (raw.summary ?? '').trim().slice(0, 500),
      likes, url, collectedAt, new Date().toISOString(),
    )
    if (result.changes > 0) imported++
    else skipped++ // 同一用户重复链接，唯一索引拦截
  }
  return { imported, skipped }
}

/** 单条删除与清空（用户可清理过期线索） */
export function deleteResearch(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM xhs_research WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

export function clearResearch(userId: string): number {
  return db.prepare('DELETE FROM xhs_research WHERE user_id = ?').run(userId).changes
}

/**
 * 把线索压缩成注入 prompt 的文本。
 * 关键约束：这些是用户自己采集的笔记线索，不是评分；点赞数是热度不是口碑分；
 * 模型可参考其中的地点/店名/玩法/避坑点，但必须回源核实，不得编造评分、价格与官方信息。
 */
export function researchPrompt(bundle: ResearchBundle | null): string {
  if (!bundle || bundle.items.length === 0) {
    return ''
  }
  const byCategory = new Map<ResearchCategory, ResearchItem[]>()
  for (const item of bundle.items) {
    const list = byCategory.get(item.category) ?? []
    list.push(item)
    byCategory.set(item.category, list)
  }
  const blocks = (Object.keys(RESEARCH_CATEGORY_LABELS) as ResearchCategory[]).map((category) => {
    const items = byCategory.get(category) ?? []
    if (items.length === 0) return null
    const lines = items.slice(0, 8).map((item) => {
      const heat = item.likes !== null ? `，浏览热度(点赞) ${item.likes}` : ''
      const author = item.author ? `，作者 @${item.author}` : ''
      const summary = item.summary ? `：${item.summary}` : ''
      return `- ${item.title || '（无标题）'}${author}${heat}${summary}｜回源 ${item.url}`
    })
    return `【${RESEARCH_CATEGORY_LABELS[category]}】\n${lines.join('\n')}`
  }).filter(Boolean)

  return [
    '【用户实采的小红书笔记线索：由用户在自己浏览器采集并导入，非评分数据】',
    ...blocks,
    '',
    '使用约束：',
    '1. 以上是用户自行采集的真实笔记线索，可作为目的地、店名、街区、玩法与避坑参考，让行程更贴近真实体验。',
    '2. 这些线索不含评分；点赞数只是内容热度，绝不能当作评分、星级或口碑分，禁止据此写「评分高」「口碑好」。',
    '3. 可引用线索里的具体地点/菜品/玩法名称，但开放时间、票价、地址、预约要求必须提示用户回源或到官方渠道核实，不得编造。',
    '4. 不要虚构这里没有出现的店名、酒店名或笔记内容；不同笔记说法冲突时，提示用户自行判断。',
  ].join('\n')
}
