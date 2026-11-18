import type { GeoBundle, GeoPoi } from './types'

/**
 * 地图定位的展示层：前后端共用（后端生成独立 HTML 指南，前端渲染预览）。
 *
 * 所有进入片段的模型输出、地点名、地址都必须经过 esc；图片只允许内嵌 data URI，
 * 链接只允许 https，避免把模型输出变成 XSS 入口。
 * 图片策略：只有官方静态地图服务真实返回的截图才渲染；拿不到就不画任何图，
 * 只保留高德 / Google Maps 官方深链，不再用自绘 SVG 冒充地图。
 */

export function esc(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[ch] ?? ch
  })
}

function safeImage(uri: string | null): string | null {
  if (!uri) return null
  return /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(uri) ? uri : null
}

function safeLink(url: string | null | undefined): string | null {
  return url && /^https:\/\//i.test(url) ? url : null
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 官方 URI API：不需要 API Key 即可打开定位/搜索结果，零密钥模式下这是唯一的定位能力 */
export function buildDeepLinks(name: string, city = ''): { amapLink: string; googleLink: string } {
  const keyword = city ? `${name} ${city}` : name
  return {
    amapLink: `https://uri.amap.com/search?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}&view=map&src=travel-planner&callnative=0`,
    googleLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(keyword)}`,
  }
}

/** 有精确坐标时，高德深链直接落到点位（GCJ-02，避免国内偏移） */
export function markerLink(poi: GeoPoi): string {
  if (poi.gcjLng === null || poi.gcjLat === null) return poi.amapLink
  return `https://uri.amap.com/marker?position=${poi.gcjLng},${poi.gcjLat}&name=${encodeURIComponent(poi.name)}&src=travel-planner&callnative=0&coordinate=gaode`
}

/** 地点名匹配：优先精确，其次互相包含（模型可能在「宽窄巷子」后补上「景区」） */
export function matchGeoPoi(geo: GeoBundle | null, name: string): GeoPoi | null {
  if (!geo) return null
  const key = name.trim().toLowerCase()
  if (!key) return null
  const exact = geo.pois.find((poi) => poi.name.trim().toLowerCase() === key)
  if (exact) return exact
  return geo.pois.find((poi) => {
    const candidate = poi.name.trim().toLowerCase()
    return candidate.length > 1 && (key.includes(candidate) || candidate.includes(key))
  }) ?? null
}

/** 指南里出现的地点可能不在第一阶段 places 中，兜底给一张只有官方深链的示意卡 */
export function fallbackGeoPoi(name: string, city: string): GeoPoi {
  const links = buildDeepLinks(name, city)
  return {
    name,
    city,
    lng: null,
    lat: null,
    gcjLng: null,
    gcjLat: null,
    address: null,
    poiId: null,
    provider: null,
    accuracy: 'link-only',
    staticImage: null,
    ...links,
    note: '未取得精确坐标，仅提供官方地图搜索入口',
  }
}

/**
 * 单个地点的定位卡：只有拿到官方静态地图截图时才渲染图片；
 * 否则只显示地点名、地址（若有）与官方地图深链，不画示意图、不伪造地图。
 */
export function renderSpotMapCard(poi: GeoPoi, index: number): string {
  const image = safeImage(poi.staticImage)
  const amap = safeLink(markerLink(poi))
  const google = safeLink(poi.googleLink)
  const hasCoord = poi.lng !== null && poi.lat !== null
  const coordText = hasCoord
    ? `${poi.lat!.toFixed(5)}°N, ${poi.lng!.toFixed(5)}°E · WGS-84`
    : '精确坐标未获取'

  // 官方静态地图没拿到时不输出任何图片区块，只留文字与链接
  const figure = image
    ? `<div class="geo-fig">
        <img class="geo-fig-img" src="${esc(image)}" alt="${esc(poi.name)} 的地图截图">
        <span class="geo-badge">${String(index + 1).padStart(2, '0')}</span>
        <span class="geo-credit">地图数据 © ${esc(poi.provider === 'google' ? 'Google' : '高德地图')}</span>
      </div>`
    : ''

  const address = poi.address ? `<p class="geo-address">${esc(poi.address)}</p>` : ''
  const links = [amap, google]
    .filter((url): url is string => Boolean(url))
    .map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${i === 0 ? '高德地图' : 'Google Maps'} ↗</a>`)
    .join('')

  return `<div class="geo-card${image ? '' : ' geo-card-links-only'}">
    ${figure}
    <div class="geo-caption">
      <h4><span class="geo-index">${String(index + 1).padStart(2, '0')}</span> ${esc(clip(poi.name, 20))}</h4>
      <p class="geo-coord">${esc(coordText)}</p>
      ${address}
      <p class="geo-note">${esc(poi.note)}</p>
      <div class="geo-links">${links}</div>
    </div>
  </div>`
}

/**
 * 行程地点清单：只列顺序与各点的官方地图链接，不渲染自绘 SVG 路线图。
 * 无法提供准确地图图片时，链接就是最诚实、最可用的定位方式。
 */
export function renderRouteMap(spots: Array<{ name: string }>, geo: GeoBundle | null): string {
  if (!spots.length) return ''
  const items = spots
    .map((spot, index) => {
      const poi = matchGeoPoi(geo, spot.name) ?? fallbackGeoPoi(spot.name, geo?.city ?? '')
      const amap = safeLink(markerLink(poi))
      const google = safeLink(poi.googleLink)
      const links = [amap, google]
        .filter((url): url is string => Boolean(url))
        .map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${i === 0 ? '高德' : 'Google'} ↗</a>`)
        .join(' ')
      return `<li><span class="geo-route-no">${String(index + 1).padStart(2, '0')}</span><b>${esc(clip(spot.name, 20))}</b><span class="geo-route-links">${links}</span></li>`
    })
    .join('')
  return `<ol class="geo-route-list">${items}</ol>`
}

/** 定位模式说明：明确「没有准确图片就不画图」，只保留官方深链 */
export function renderGeoStatus(geo: GeoBundle | null): string {
  if (!geo) return '<p class="geo-status">定位方式：官方地图搜索深链。未采集到地图数据，出行前请自行核实位置。</p>'
  const exact = geo.pois.filter((poi) => poi.accuracy === 'exact').length
  const images = geo.pois.filter((poi) => safeImage(poi.staticImage)).length
  const mode = geo.provider
    ? `定位方式：${esc(geo.providerLabel)}官方 API 核对（${exact}/${geo.pois.length} 个地点取得精确坐标${images ? `，${images} 张官方静态地图截图` : '；未取得静态地图截图，仅保留地图链接'}）`
    : `定位方式：高德 / Google Maps 官方深链（未配置地图 API Key，不渲染地图图片，仅提供定位链接）`
  const degraded = geo.degraded.length ? `　|　已降级：${esc(geo.degraded.join('、'))}` : ''
  return `<p class="geo-status">${mode}${degraded}<br>${esc(geo.attribution)}</p>`
}
