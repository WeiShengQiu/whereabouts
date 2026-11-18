import type { GeoBundle, GeoPoi } from './types'

/**
 * 地图定位的展示层：前后端共用（后端生成独立 HTML 指南，前端渲染预览）。
 *
 * 所有进入片段的模型输出、地点名、地址都必须经过 esc；图片只允许内嵌 data URI，
 * 链接只允许 https，避免把模型输出变成 XSS 入口。
 * 没有官方静态地图时画的是「明确标注的示意图」，绝不伪装成真实地图或编造坐标。
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

/** 单个地点的图文卡：优先官方静态地图，否则输出明确标注的自绘 SVG 示意图 */
export function renderSpotMapCard(poi: GeoPoi, index: number): string {
  const uid = `geo${index}`
  const image = safeImage(poi.staticImage)
  const amap = safeLink(markerLink(poi))
  const google = safeLink(poi.googleLink)
  const hasCoord = poi.lng !== null && poi.lat !== null
  const coordText = hasCoord
    ? `${poi.lat!.toFixed(5)}°N, ${poi.lng!.toFixed(5)}°E · WGS-84`
    : '精确坐标未获取'

  const figure = image
    ? `<img class="geo-fig-img" src="${esc(image)}" alt="${esc(poi.name)} 的地图截图">`
    : `<svg class="geo-fig-svg" viewBox="0 0 400 220" role="img" aria-label="${esc(poi.name)} 位置示意图" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${uid}bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#1b2027"/><stop offset="1" stop-color="#101317"/>
          </linearGradient>
          <pattern id="${uid}grid" width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M26 0H0V26" fill="none" stroke="rgba(214,188,132,.10)" stroke-width="1"/>
          </pattern>
        </defs>
        <rect width="400" height="220" fill="url(#${uid}bg)"/>
        <rect width="400" height="220" fill="url(#${uid}grid)"/>
        <path d="M-10 164 C 80 138, 150 196, 246 150 S 352 116, 410 140" fill="none" stroke="rgba(214,188,132,.13)" stroke-width="12"/>
        <path d="M74 -10 C 98 66, 54 126, 122 230" fill="none" stroke="rgba(214,188,132,.10)" stroke-width="9"/>
        <path d="M300 -10 C 286 70, 342 120, 318 230" fill="none" stroke="rgba(214,188,132,.08)" stroke-width="7"/>
        <circle cx="200" cy="100" r="42" fill="none" stroke="rgba(214,188,132,.16)" stroke-width="1"/>
        <circle cx="200" cy="100" r="62" fill="none" stroke="rgba(214,188,132,.08)" stroke-width="1" stroke-dasharray="4 6"/>
        <g transform="translate(200,98)">
          <path d="M0 -32 C 14 -32, 24 -21, 24 -8 C 24 9, 0 28, 0 28 S -24 9, -24 -8 C -24 -21, -14 -32, 0 -32 Z" fill="#d6bc84"/>
          <circle cx="0" cy="-9" r="9" fill="#131519"/>
        </g>
        <text x="200" y="152" text-anchor="middle" fill="#d6bc84" font-size="13" letter-spacing="2">${esc(clip(poi.name, 14))}</text>
        <text x="200" y="204" text-anchor="middle" fill="#8d8b86" font-size="10" letter-spacing="1">位置示意图 · 非实测地图</text>
      </svg>`

  const address = poi.address ? `<p class="geo-address">${esc(poi.address)}</p>` : ''
  const links = [amap, google]
    .filter((url): url is string => Boolean(url))
    .map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${i === 0 ? '高德地图' : 'Google Maps'} ↗</a>`)
    .join('')

  return `<figure class="geo-card">
    <div class="geo-fig">
      ${figure}
      <span class="geo-badge">${String(index + 1).padStart(2, '0')}</span>
      ${image ? `<span class="geo-credit">地图数据 © ${esc(poi.provider === 'google' ? 'Google' : '高德地图')}</span>` : ''}
    </div>
    <figcaption class="geo-caption">
      <h4>${esc(poi.name)}</h4>
      <p class="geo-coord">${esc(coordText)}</p>
      ${address}
      <p class="geo-note">${esc(poi.note)}</p>
      <div class="geo-links">${links}</div>
    </figcaption>
  </figure>`
}

interface RoutePoint {
  name: string
  lng: number | null
  lat: number | null
}

/** 顶部行程路线总览图：全部地点都有坐标时按真实经纬度投影，否则退化为等距顺序示意 */
export function renderRouteMap(spots: Array<{ name: string }>, geo: GeoBundle | null): string {
  if (!spots.length) return ''
  const points: RoutePoint[] = spots.map((spot) => {
    const poi = matchGeoPoi(geo, spot.name)
    return { name: spot.name, lng: poi?.lng ?? null, lat: poi?.lat ?? null }
  })
  const allLocated = points.every((point) => point.lng !== null && point.lat !== null)
  const W = 760
  const H = 250
  let coords: Array<{ x: number; y: number }>

  if (allLocated && points.length >= 2) {
    const lngs = points.map((p) => p.lng as number)
    const lats = points.map((p) => p.lat as number)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const spanX = maxLng - minLng || 0.01
    const spanY = maxLat - minLat || 0.01
    coords = points.map((p) => ({
      x: 70 + ((p.lng as number) - minLng) / spanX * 620,
      y: 178 - ((p.lat as number) - minLat) / spanY * 128,
    }))
  } else {
    const step = points.length > 1 ? 620 / (points.length - 1) : 0
    coords = points.map((_, index) => ({
      x: points.length > 1 ? 70 + index * step : W / 2,
      y: 112 + (index % 2 === 0 ? -14 : 14),
    }))
  }

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const nodes = coords
    .map((c, i) => {
      const labelY = c.y > 150 ? c.y - 24 : c.y + 34
      return `<g>
        <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="17" fill="rgba(214,188,132,.12)"/>
        <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="11" fill="#131519" stroke="#d6bc84" stroke-width="1.5"/>
        <text x="${c.x.toFixed(1)}" y="${(c.y + 4).toFixed(1)}" text-anchor="middle" fill="#d6bc84" font-size="11">${i + 1}</text>
        <text x="${c.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="#ece9e2" font-size="11">${esc(clip(points[i].name, 8))}</text>
      </g>`
    })
    .join('')
  const note = allLocated && points.length >= 2
    ? '按实际经纬度投影 · 仅表示相对方位，非导航路线与真实距离'
    : '按行程顺序排列 · 未取得全部精确坐标，图示不代表真实方位'

  return `<div class="geo-route">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="行程地点总览图" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="geoRouteGrid" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M34 0H0V34" fill="none" stroke="rgba(214,188,132,.07)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="#111418"/>
      <rect width="${W}" height="${H}" fill="url(#geoRouteGrid)"/>
      <path d="${path}" fill="none" stroke="rgba(214,188,132,.55)" stroke-width="1.5" stroke-dasharray="6 6"/>
      ${nodes}
      <text x="${W / 2}" y="232" text-anchor="middle" fill="#8d8b86" font-size="10" letter-spacing="1">${esc(note)}</text>
    </svg>
  </div>`
}

/** 定位模式与降级说明，随指南一起展示，避免用户把示意图当成真实地图 */
export function renderGeoStatus(geo: GeoBundle | null): string {
  if (!geo) return '<p class="geo-status">定位模式：未采集地图信息，地点仅提供官方地图搜索入口。</p>'
  const exact = geo.pois.filter((poi) => poi.accuracy === 'exact').length
  const mode = geo.provider
    ? `定位模式：${esc(geo.providerLabel)}官方 API（${exact}/${geo.pois.length} 个地点取得精确坐标与地图截图）`
    : `定位模式：官方地图深链（未配置地图 API Key，${geo.pois.length} 个地点均为示意图）`
  const degraded = geo.degraded.length ? `　|　已降级：${esc(geo.degraded.join('、'))}` : ''
  return `<p class="geo-status">${mode}${degraded}<br>${esc(geo.attribution)}</p>`
}
