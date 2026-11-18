import {
  esc,
  fallbackGeoPoi,
  matchGeoPoi,
  renderGeoStatus,
  renderRouteMap,
  renderSpotMapCard,
} from '../../shared/geo-view'
import { heatLabel, matchNotes, notesByCategory, safeCover } from '../../shared/research-view'
import { RESEARCH_CATEGORY_LABELS } from '../../shared/types'
import type { GeoBundle, GuideDay, ResearchBundle, TravelGuide } from '../../shared/types'

function list(items: string[]): string {
  if (!items.length) return '<p class="muted">暂无</p>'
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
}

/** 小红书实采笔记：只贴用户自己采集的具体笔记（封面 + 标题 + 作者 + 热度 + 回源链接），不展示第三方评分 */
function xhsNotesSection(research: ResearchBundle | null): string {
  const groups = notesByCategory(research)
  if (!groups.length) {
    return '<p class="muted">本次没有实采笔记。在平台安装采集扩展并登录小红书后，生成方案时会自动采集并展示在这里。</p>'
  }
  return groups
    .map((group) => {
      const cards = group.items
        .map((note) => {
          const cover = safeCover(note.cover)
          const heat = heatLabel(note.likes)
          return `<a class="xhs-card" href="${esc(note.url)}" target="_blank" rel="noopener noreferrer">
            <div class="xhs-card-cover">${cover ? `<img src="${esc(cover)}" alt="笔记封面" loading="lazy">` : '<span class="xhs-card-ph">小红书笔记</span>'}</div>
            <div class="xhs-card-body"><b>${esc(note.title || '（无标题笔记）')}</b>
              <small>${esc(note.author ? `@${note.author}` : '小红书用户')}${heat ? ` · ${esc(heat)}` : ''} ↗</small>
              ${note.summary ? `<span class="xhs-card-summary">${esc(note.summary.slice(0, 60))}</span>` : ''}
            </div>
          </a>`
        })
        .join('')
      return `<div class="ev-block"><h3>${esc(RESEARCH_CATEGORY_LABELS[group.category])}（${group.items.length}）</h3><div class="xhs-card-grid">${cards}</div></div>`
    })
    .join('')
}

/** 地点图册里挂的相关笔记：封面缩略图 + 标题 + 回源链接，图文结合且可核对 */
function spotNotesHtml(research: ResearchBundle | null, name: string, category: string): string {
  const notes = matchNotes(research?.items ?? [], name, category, 2)
  if (!notes.length) return ''
  return `<div class="spot-notes"><p class="spot-notes-title">相关小红书笔记（用户实采 · 非评分）</p>${notes
    .map((note) => {
      const cover = safeCover(note.cover)
      const heat = heatLabel(note.likes)
      return `<a class="spot-note" href="${esc(note.url)}" target="_blank" rel="noopener noreferrer">
        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ''}
        <span class="spot-note-text"><b>${esc(note.title || '（无标题笔记）')}</b>
          <small>${esc(note.author ? `@${note.author}` : '小红书笔记')}${heat ? ` · ${esc(heat)}` : ''} ↗</small>
        </span>
      </a>`
    })
    .join('')}</div>`
}

/** 时段图标：纯线条 SVG，打印友好，不依赖任何外部资源 */
const SEGMENTS: Array<{ key: keyof Omit<GuideDay, 'day' | 'title'>; label: string; path: string }> = [
  { key: 'morning', label: '上午', path: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  { key: 'afternoon', label: '下午', path: '<circle cx="12" cy="9" r="4"/><path d="M2 20h20M5 16l3-4M19 16l-3-4M12 2v1"/>' },
  { key: 'evening', label: '晚上', path: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/><path d="M17 3v3M15.5 4.5h3"/>' },
  { key: 'meals', label: '餐饮', path: '<path d="M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 3c-2 2-2 6 0 8h2V3M18 11v10"/>' },
  { key: 'transport', label: '交通', path: '<path d="M3 16h18M5 16V9l2-4h10l2 4v7M7 16v2M17 16v2M6 12h12"/>' },
  { key: 'tips', label: '贴士', path: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.8 1 1.5 1 2.5h6c0-1 .3-1.7 1-2.5A6 6 0 0 0 12 3Z"/>' },
]

function segmentIcon(path: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

function daySection(day: GuideDay, index: number): string {
  const segments = SEGMENTS.map(
    (segment) => `<div class="segment">
      <span class="segment-icon">${segmentIcon(segment.path)}</span>
      <div class="segment-text"><b>${segment.label}</b><p>${esc(day[segment.key])}</p></div>
    </div>`,
  ).join('')
  return `<section class="day">
    <h3><span class="day-no">D${index + 1}</span>${esc(day.day)} · ${esc(day.title)}</h3>
    <div class="segments">${segments}</div>
  </section>`
}

/** 地点图册：官方地图截图（拿到才显示）+ 详细文案 + 相关小红书实采笔记 + 定位深链 */
function atlasSection(guide: TravelGuide, geo: GeoBundle | null, research: ResearchBundle | null): string {
  const spots = guide.spots ?? []
  if (!spots.length) return '<p class="muted">本指南未包含地点图册。</p>'
  return `<div class="spot-grid">${spots
    .map((spot, index) => {
      const poi = matchGeoPoi(geo, spot.name) ?? fallbackGeoPoi(spot.name, geo?.city ?? '')
      const highlights = spot.highlights.length
        ? `<ul class="spot-list">${spot.highlights.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
        : ''
      return `<article class="spot">
        ${renderSpotMapCard(poi, index)}
        <div class="spot-body">
          <div class="spot-tags">
            <span>${esc(spot.category)}</span><span>${esc(spot.day)} ${esc(spot.time)}</span>
            <span>停留 ${esc(spot.stay)}</span><span>${esc(spot.cost)}</span>
          </div>
          <p class="spot-intro">${esc(spot.intro)}</p>
          ${highlights}
          <p class="spot-extra"><b>贴士</b>${esc(spot.tips)}</p>
          <p class="spot-extra"><b>取景</b>${esc(spot.photo)}</p>
          ${spotNotesHtml(research, spot.name, spot.category)}
        </div>
      </article>`
    })
    .join('')}</div>`
}

function mapNotes(geo: GeoBundle | null): string {
  return `${renderGeoStatus(geo)}
  <ul class="geo-notes">
    <li>拿不到官方静态地图截图时，地点卡<b>不渲染任何地图图片</b>，只保留高德 / Google Maps 官方链接；点击链接查看精确位置。</li>
    <li>地点坐标统一为 WGS-84；高德返回的 GCJ-02 已做转换供 Google Maps 使用，高德深链仍使用原始 GCJ-02 以避免偏移。</li>
    <li>「高德地图 / Google Maps」链接使用两家官方 URI API 与 Maps URLs，按地点名打开地图，本身不需要 API Key。</li>
    <li>系统不抓取第三方平台的点评与评分；地图截图（若启用）来自官方静态地图服务，仅在导出时实时取用并内嵌，不写入数据库、不暴露密钥。</li>
    <li>行程地点清单只按顺序罗列，<b>不是导航路线，也不代表真实距离</b>；实际交通请以地图 App 规划为准。</li>
  </ul>`
}

/** 与 Web 端「墨黑 + 香槟金」一致的独立单文件模板；自包含、离线可看、打印时反白省墨 */
export function renderGuideHtml(
  guide: TravelGuide,
  requirement: string,
  geo: GeoBundle | null = null,
  research: ResearchBundle | null = null,
): string {
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const days = guide.days.map(daySection).join('')
  const spots = guide.spots ?? []
  const routeNames: Array<{ name: string }> = spots.length ? spots : (geo?.pois ?? [])
  const route = renderRouteMap(routeNames, geo)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(guide.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 20px; background: #0a0b0d; color: #ece9e2;
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.8; }
  .sheet { max-width: 960px; margin: 0 auto; padding: 56px 60px;
           background: linear-gradient(180deg, rgba(255,255,255,.022), transparent), #131519;
           border: 1px solid rgba(214,188,132,.18); }
  .eyebrow { font-size: 10px; letter-spacing: .34em; color: #b99a60; margin: 0 0 18px; }
  h1 { font-family: Georgia, "Songti SC", serif; font-size: 38px; font-weight: 400;
       margin: 0 0 14px; line-height: 1.3; }
  .meta { color: #8d8b86; font-size: 13px; letter-spacing: .1em; margin: 0 0 28px; }
  .overview { background: linear-gradient(90deg, rgba(214,188,132,.09), transparent);
              border-left: 2px solid #b99a60; padding: 18px 22px; margin: 0 0 40px; }
  h2 { font-family: Georgia, "Songti SC", serif; font-size: 22px; font-weight: 400;
       margin: 44px 0 18px; padding-bottom: 10px; border-bottom: 1px solid rgba(214,188,132,.18); }
  .day { margin: 0 0 16px; padding: 20px 24px; border: 1px solid rgba(214,188,132,.14); background: rgba(0,0,0,.18); }
  .day h3 { font-family: Georgia, "Songti SC", serif; font-size: 17px; font-weight: 400; margin: 0 0 16px; }
  .day-no { display: inline-block; min-width: 48px; margin-right: 10px; color: #d6bc84; font-size: 20px; }
  .segments { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 22px; }
  .segment { display: flex; gap: 12px; }
  .segment-icon { flex: 0 0 30px; height: 30px; display: grid; place-items: center;
                  border: 1px solid rgba(214,188,132,.22); border-radius: 50%; color: #d6bc84; }
  .segment-icon svg { width: 17px; height: 17px; }
  .segment-text b { display: block; color: #b99a60; font-size: 12px; font-weight: 400; letter-spacing: .1em; }
  .segment-text p { margin: 2px 0 0; font-size: 13px; color: #cfccc5; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 5px 0; font-size: 13px; }
  .muted { color: #8d8b86; font-size: 13px; }
  .budget { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .pill { display: inline-block; border: 1px solid rgba(214,188,132,.28); color: #d6bc84; border-radius: 20px; padding: 4px 14px; font-size: 12px; margin: 0 6px 6px 0; }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; }
  .ev-block { margin: 0 0 16px; padding: 18px 22px; border: 1px solid rgba(214,188,132,.14); background: rgba(0,0,0,.18); }
  .ev-block h3 { font-size: 15px; font-weight: 400; margin: 0 0 12px; color: #d6bc84; }
  .ev-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  .ev-table th, .ev-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid rgba(214,188,132,.12); color: #cfccc5; }
  .ev-table th { color: #b99a60; font-weight: 400; }
  a { color: #d6bc84; text-decoration: none; }
  .ev-links a { margin-right: 12px; }

  /* 行程地点清单与地图卡（无官方截图时不渲染图片，只留链接） */
  .geo-route-list { margin: 0; padding: 0; list-style: none; }
  .geo-route-list li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid rgba(214,188,132,.12); font-size: 13px; }
  .geo-route-no { color: #b99a60; font-size: 11px; letter-spacing: .1em; }
  .geo-route-list b { font-weight: 400; color: #ece9e2; flex: 1; }
  .geo-route-links a { margin-left: 10px; font-size: 11px; }
  .geo-status { margin: 14px 0 0; padding: 12px 16px; font-size: 12px; color: #a9a69f;
                border-left: 2px solid rgba(214,188,132,.45); background: rgba(214,188,132,.05); }
  .geo-notes { font-size: 12px; color: #a9a69f; }
  .geo-notes li { margin: 8px 0; }
  .geo-notes b { color: #d6bc84; font-weight: 400; }
  .spot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; }
  .spot { border: 1px solid rgba(214,188,132,.16); background: rgba(0,0,0,.2); overflow: hidden; }
  .geo-card { margin: 0; }
  .geo-index { display: inline-block; min-width: 26px; color: #b99a60; font-size: 12px; letter-spacing: .1em; }
  .geo-fig { position: relative; background: #111418; line-height: 0; }
  .geo-fig-img { display: block; width: 100%; height: auto; }
  .geo-badge { position: absolute; top: 12px; left: 12px; padding: 3px 10px; font-size: 11px;
               letter-spacing: .12em; color: #131519; background: #d6bc84; border-radius: 2px; line-height: 1.6; }
  .geo-credit { position: absolute; right: 8px; bottom: 6px; font-size: 9px; color: #ece9e2;
                background: rgba(0,0,0,.55); padding: 2px 6px; line-height: 1.5; }
  .geo-caption { padding: 14px 16px 16px; border-top: 1px solid rgba(214,188,132,.12); line-height: 1.6; }
  .geo-caption h4 { margin: 0 0 6px; font-family: Georgia, "Songti SC", serif; font-size: 16px; font-weight: 400; color: #ece9e2; }
  .geo-coord, .geo-address, .geo-note { margin: 2px 0; font-size: 11px; color: #8d8b86; }
  .geo-address { color: #b6b2a9; }
  .geo-links { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .geo-links a { display: inline-block; border: 1px solid rgba(214,188,132,.32); border-radius: 2px;
                 padding: 3px 10px; font-size: 11px; }
  .spot-body { padding: 4px 16px 18px; }
  .spot-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
  .spot-tags span { border: 1px solid rgba(214,188,132,.22); color: #c8b184; border-radius: 12px;
                    padding: 2px 9px; font-size: 11px; }
  .spot-intro { margin: 0 0 10px; font-size: 13px; color: #cfccc5; }
  .spot-list { margin: 0 0 10px; padding-left: 18px; }
  .spot-list li { color: #cfccc5; }
  .spot-extra { margin: 6px 0 0; font-size: 12px; color: #a9a69f; }
  .spot-extra b { display: inline-block; margin-right: 8px; color: #b99a60; font-weight: 400; }

  /* 真实小红书笔记卡片（封面 + 标题 + 作者 + 热度），不是评分表 */
  .xhs-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
  .xhs-card { display: block; border: 1px solid rgba(214,188,132,.16); background: rgba(0,0,0,.2); overflow: hidden; }
  .xhs-card-cover { height: 130px; background: #111418; overflow: hidden; line-height: 0; display: grid; place-items: center; }
  .xhs-card-cover img { width: 100%; height: 100%; object-fit: cover; }
  .xhs-card-ph { font-size: 12px; color: #8d8b86; }
  .xhs-card-body { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; }
  .xhs-card-body b { font-size: 13px; font-weight: 400; color: #ece9e2; line-height: 1.5; }
  .xhs-card-body small { font-size: 11px; color: #b99a60; }
  .xhs-card-summary { font-size: 11px; color: #a9a69f; line-height: 1.5; }
  .spot-notes { margin-top: 12px; padding-top: 10px; border-top: 1px dashed rgba(214,188,132,.2); }
  .spot-notes-title { margin: 0 0 8px; font-size: 11px; color: #b99a60; letter-spacing: .04em; }
  .spot-note { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 12px; }
  .spot-note img { width: 46px; height: 46px; object-fit: cover; flex: 0 0 46px; }
  .spot-note-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .spot-note-text b { font-weight: 400; color: #ece9e2; line-height: 1.4; }
  .spot-note-text small { color: #b99a60; font-size: 11px; }
  footer { margin-top: 52px; padding-top: 18px; border-top: 1px solid rgba(214,188,132,.18); font-size: 12px; color: #8d8b86; }
  .requirement { word-break: break-word; }
  @media print {
    :root { color-scheme: light; }
    body { background: #fff; color: #222; padding: 0; }
    .sheet { border: 0; padding: 0; max-width: none; background: #fff; }
    h1, h2, .day h3, .day-no, dt, .pill, .ev-block h3, .spot-extra b, .geo-notes b { color: #8a6b2c; }
    .overview, .geo-status { background: #faf6ec; }
    .day, .ev-block, .spot, .geo-route-list, .xhs-card { border-color: #ddd; background: #fff; }
    .segment-text p, .spot-intro, .spot-list li, dd, .meta, footer, .muted,
    .geo-coord, .geo-note, .spot-extra, .geo-notes, .xhs-card-summary { color: #444; }
    a, .geo-links a, .geo-caption h4, .xhs-card-body b, .spot-note-text b { color: #8a6b2c; }
    .segment-icon, .spot-tags span, .pill, .geo-links a, .xhs-card { border-color: #cbb78c; }
    .day, .ev-block, .spot, .geo-route-list, .xhs-card { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="sheet">
  <p class="eyebrow">CURATED JOURNEYS · 行迹</p>
  <h1>${esc(guide.title)}</h1>
  <p class="meta">目的地 ${esc(guide.destination)}　|　行程 ${esc(guide.duration)}　|　${spots.length} 个地点图文详解</p>
  <div class="overview">${esc(guide.overview)}</div>

  <h2>行程总览</h2>
  ${route || '<p class="muted">本次未生成地点总览图。</p>'}
  ${renderGeoStatus(geo)}

  <h2>每日行程</h2>
  ${days || '<p class="muted">暂无行程</p>'}

  <h2>地点图册 · 图文详解</h2>
  ${atlasSection(guide, geo, research)}

  <h2>预算参考</h2>
  <div class="budget"><span class="pill">档位 ${esc(guide.budget.level)}</span><span class="pill">合计 ${esc(guide.budget.total)}</span></div>
  ${list(guide.budget.items)}

  <div class="grid-2">
    <div><h2>行前清单</h2>${list(guide.packing)}</div>
    <div><h2>注意事项</h2>${list(guide.notes)}</div>
  </div>

  <h2>小红书实采笔记（用户采集 · 非评分）</h2>
  ${xhsNotesSection(research)}
  <p class="muted">以上为你用浏览器实采的具体笔记，仅作地点、店名与玩法参考；点赞只是热度不是评分，营业时间、票价与地址请以官方渠道为准。</p>

  <h2>地图定位与图源说明</h2>
  ${mapNotes(geo)}

  <footer>
    <p>原始需求：<span class="requirement">${esc(requirement)}</span></p>
    <p>本指南由 AI 生成，行程、价格、地址与开放信息请在出行前通过官方渠道二次核实；小红书笔记为你自行采集，非评分数据，点赞只是热度；地图截图（若有）来自官方静态地图服务，无截图时仅保留官方定位链接。生成时间：${esc(generatedAt)}</p>
  </footer>
</div>
</body>
</html>`
}
