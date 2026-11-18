import type { ResearchBundle, ResearchCategory, ResearchItem } from './types'

/** 封面图只接受小红书官方 CDN 的 https 图片，避免把任意外链写进页面 */
export function safeCover(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return ''
    const host = url.hostname.toLowerCase()
    if (host !== 'xhscdn.com' && !host.endsWith('.xhscdn.com')) return ''
    return url.toString().slice(0, 1200)
  } catch {
    return ''
  }
}

const CATEGORY_HINT: Record<string, ResearchCategory> = {
  餐饮: 'food',
  美食: 'food',
  住宿: 'hotel',
  酒店: 'hotel',
  民宿: 'hotel',
  交通: 'transport',
  景点: 'attraction',
  街区: 'attraction',
  自然: 'attraction',
  人文: 'attraction',
}

/**
 * 为地点图册匹配相关笔记：标题/摘要/检索词命中地点名得分，分类对应再加一点权重。
 * 只返回真实命中的笔记，宁缺毋滥——不要把无关笔记硬塞给地点。
 */
export function matchNotes(items: ResearchItem[], name: string, spotCategory = '', limit = 2): ResearchItem[] {
  const key = name.trim().toLowerCase()
  if (!key) return []
  const hint = CATEGORY_HINT[spotCategory.trim()]
  const scored = items
    .map((item) => {
      const keyword = item.keyword.toLowerCase()
      const title = item.title.toLowerCase()
      const summary = item.summary.toLowerCase()
      let score = 0
      if (keyword && (keyword.includes(key) || key.includes(keyword))) score += 6
      if (title.includes(key)) score += 5
      if (summary.includes(key)) score += 2
      if (hint && item.category === hint) score += 1
      return { item, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.likes ?? 0) - (a.item.likes ?? 0))
  return scored.slice(0, limit).map((entry) => entry.item)
}

/** 按分类分组的笔记（供图文画廊展示），只返回有内容的分类 */
export function notesByCategory(bundle: ResearchBundle | null): Array<{ category: ResearchCategory; items: ResearchItem[] }> {
  if (!bundle?.items.length) return []
  const order: ResearchCategory[] = ['hotel', 'transport', 'food', 'attraction']
  return order
    .map((category) => ({ category, items: bundle.items.filter((item) => item.category === category).slice(0, 8) }))
    .filter((group) => group.items.length > 0)
}

/** 热度文案：点赞只是内容热度，绝不当成评分 */
export function heatLabel(likes: number | null): string {
  return likes === null ? '' : `热度 ${likes >= 10000 ? `${(likes / 10000).toFixed(1)}万` : likes}`
}
