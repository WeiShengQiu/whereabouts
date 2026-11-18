import { EVIDENCE_SOURCE_LABELS } from '../../shared/types'
import {
  esc,
  fallbackGeoPoi,
  matchGeoPoi,
  renderGeoStatus,
  renderRouteMap,
  renderSpotMapCard,
} from '../../shared/geo-view'
import type { EvidenceBundle, GeoBundle, GuideDay, TravelGuide } from '../../shared/types'

function list(items: string[]): string {
  if (!items.length) return '<p class="muted">暂无</p>'
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
}

/** 口碑证据区块：只呈现系统实际取到的数据，缺失源明确列出，绝不由模板补分 */
function evidenceSection(bundle: EvidenceBundle | null): string {
  if (!bundle || !bundle.matrices.length) {
    return '<p class="muted">本次未提取到可核对的地点，指南中的地点描述未经第三方口碑数据核对。</p>'
  }
  return bundle.matrices
    .map((matrix) => {
      const rows = matrix.items.length
        ? `<table class="ev-table"><thead><tr><th>来源</th><th>归一化评分</th><th>原始值</th><th>评价数</th><th>获取日期</th></tr></thead><tbody>${matrix.items
            .map(
              (item) =>
                `<tr><td>${esc(EVIDENCE_SOURCE_LABELS[item.source])}</td><td>${item.rating === null ? '—' : `${item.rating.toFixed(1)} / 5`}</td><td>${esc(item.ratingRaw ?? '—')}</td><td>${item.reviewCount ?? '—'}</td><td>${esc(item.fetchedAt.slice(0, 10))}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="muted">所有数据源均未获取到数据。</p>'
      const links = matrix.sources
        .filter((source) => source.deepLink)
        .map((source) => `<a href="${esc(source.deepLink)}" target="_blank" rel="noopener noreferrer">${esc(source.label)}</a>`)
        .join(' · ')
      const missing = matrix.sources.filter((source) => source.itemCount === 0).map((source) => esc(source.label)).join('、')
      return `<div class="ev-block"><h3>${esc(matrix.poiName)}</h3>${rows}<p class="muted">未获取：${missing || '无'}　|　取证时间 ${esc(matrix.collectedAt.slice(0, 10))}</p><p class="ev-links">回源核对：${links || '—'}</p></div>`
    })
    .join('')
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

/** 地点图册：每张图文卡 = 官方地图截图或明确标注的示意图 + 定位深链 + 详细文案 */
function atlasSection(guide: TravelGuide, geo: GeoBundle | null): string {
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
        </div>
      </article>`
    })
    .join('')}</div>`
}

function mapNotes(geo: GeoBundle | null): string {
  return `${renderGeoStatus(geo)}
  <ul class="geo-notes">
    <li>标注「位置示意图」的卡片由系统绘制，用于串联行程顺序，<b>不是真实地图，也不含实测坐标</b>；精确位置请点击卡片中的官方地图链接。</li>
    <li>地点卡中的坐标统一为 WGS-84。高德返回的 GCJ-02 坐标已做转换，供 Google Maps 与行程总览图使用；高德深链仍使用原始 GCJ-02 以避免国内偏移。</li>
    <li>「高德地图 / Google Maps」链接使用两家官方 URI API 与 Maps URLs，按地点名打开地图，本身不需要 API Key。</li>
    <li>系统不抓取第三方平台的图片与点评；地图截图（若启用）来自官方静态地图服务，仅在导出时实时取用并内嵌，不写入数据库、不在页面中暴露密钥。</li>
    <li>行程总览图只表示相对方位或先后顺序，<b>不是导航路线，也不代表真实距离</b>；实际交通请以地图 App 规划为准。</li>
  </ul>`
}

/** 与 Web 端「墨黑 + 香槟金」一致的独立单文件模板；自包含、离线可看、打印时反白省墨 */
export function renderGuideHtml(
  guide: TravelGuide,
  requirement: string,
  bundle: EvidenceBundle | null = null,
  geo: GeoBundle | null = null,
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

  /* 行程总览与地图卡 */
  .geo-route { border: 1px solid rgba(214,188,132,.18); background: #111418; overflow: hidden; }
  .geo-route svg { display: block; width: 100%; height: auto; }
  .geo-status { margin: 14px 0 0; padding: 12px 16px; font-size: 12px; color: #a9a69f;
                border-left: 2px solid rgba(214,188,132,.45); background: rgba(214,188,132,.05); }
  .geo-notes { font-size: 12px; color: #a9a69f; }
  .geo-notes li { margin: 8px 0; }
  .geo-notes b { color: #d6bc84; font-weight: 400; }
  .spot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; }
  .spot { border: 1px solid rgba(214,188,132,.16); background: rgba(0,0,0,.2); overflow: hidden; }
  .geo-card { margin: 0; }
  .geo-fig { position: relative; background: #111418; line-height: 0; }
  .geo-fig-img, .geo-fig-svg { display: block; width: 100%; height: auto; }
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
  footer { margin-top: 52px; padding-top: 18px; border-top: 1px solid rgba(214,188,132,.18); font-size: 12px; color: #8d8b86; }
  .requirement { word-break: break-word; }
  @media print {
    :root { color-scheme: light; }
    body { background: #fff; color: #222; padding: 0; }
    .sheet { border: 0; padding: 0; max-width: none; background: #fff; }
    h1, h2, .day h3, .day-no, dt, .pill, .ev-block h3, .spot-extra b, .geo-notes b { color: #8a6b2c; }
    .overview, .geo-status { background: #faf6ec; }
    .day, .ev-block, .spot, .geo-route { border-color: #ddd; background: #fff; }
    .segment-text p, .spot-intro, .spot-list li, dd, .meta, footer, .muted, .ev-table th, .ev-table td,
    .geo-coord, .geo-note, .spot-extra, .geo-notes { color: #444; }
    a, .geo-links a, .ev-links a, .geo-caption h4 { color: #8a6b2c; }
    .segment-icon, .spot-tags span, .pill, .geo-links a { border-color: #cbb78c; color: #8a6b2c; }
    .geo-fig-svg rect, .geo-route svg rect { fill: #faf8f2 !important; }
    .geo-fig-svg path, .geo-fig-svg circle, .geo-route svg path, .geo-route svg circle { stroke: #cbba91 !important; }
    .geo-fig-svg text, .geo-route svg text { fill: #8a6b2c !important; }
    .day, .ev-block, .spot, .geo-route { break-inside: avoid; }
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
  ${atlasSection(guide, geo)}

  <h2>预算参考</h2>
  <div class="budget"><span class="pill">档位 ${esc(guide.budget.level)}</span><span class="pill">合计 ${esc(guide.budget.total)}</span></div>
  ${list(guide.budget.items)}

  <div class="grid-2">
    <div><h2>行前清单</h2>${list(guide.packing)}</div>
    <div><h2>注意事项</h2>${list(guide.notes)}</div>
  </div>

  <h2>第三方口碑与数据来源</h2>
  ${evidenceSection(bundle)}
  <p class="muted">各平台评分口径不同，此处不做跨平台平均；评分仅供参考，请以平台实时页面为准。</p>

  <h2>地图定位与图源说明</h2>
  ${mapNotes(geo)}

  <footer>
    <p>原始需求：<span class="requirement">${esc(requirement)}</span></p>
    <p>本指南由 AI 生成，行程、价格、地址与开放信息请在出行前通过官方渠道二次核实；口碑数据来自授权通道或用户录入，来源与获取日期见上表；地图截图与坐标来自官方地图服务，示意图不代表真实地图。生成时间：${esc(generatedAt)}</p>
  </footer>
</div>
</body>
</html>`
}
