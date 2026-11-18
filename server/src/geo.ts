import { buildDeepLinks } from '../../shared/geo-view'
import { GEO_PROVIDER_LABELS } from '../../shared/types'
import type { GenerationEmit } from './generation'
import type { GeoBundle, GeoPoi, GeoProvider } from '../../shared/types'

/**
 * 地图定位证据层。与 evidence.ts 同一套合规框架：只走官方 API 与官方 URI 深链，
 * 不抓取网页、不逆向签名、不伪装浏览器。403/429/风控一律熔断降级，不重试、不换通道硬刚。
 *
 * 两条能力档位：
 * 1. 零密钥（默认）：为每个地点生成高德 URI API / Google Maps URLs 官方深链，无需任何 Key；
 *    指南里的地图卡是系统绘制并明确标注的示意图，绝不伪造经纬度。
 * 2. 精确模式（配置 GEO_PROVIDER + Key）：调用高德 Web 服务 POI 搜索或 Google Places API，
 *    取回真实坐标与地址；静态地图图片只在导出时实时抓取并内嵌，不落库、不暴露密钥。
 */
interface ActiveProvider {
  id: GeoProvider
  key: string
}

interface LookupHit {
  gcjLng: number | null
  gcjLat: number | null
  lng: number
  lat: number
  address: string | null
  poiId: string | null
}

/** 风控/限流与普通网络错误分开：只有前者熔断，后者仅跳过本次 */
class AntiBotError extends Error {
  readonly antiBot = true
}

interface Circuit {
  until: number
  reason: string
}
const CIRCUIT_MS = 5 * 60_000
const circuits = new Map<GeoProvider, Circuit>()
const MAX_IMAGES = 6

function activeCircuit(id: GeoProvider): Circuit | null {
  const current = circuits.get(id)
  if (!current) return null
  if (current.until <= Date.now()) {
    circuits.delete(id)
    return null
  }
  return current
}

function tripCircuit(id: GeoProvider, reason: string): void {
  circuits.set(id, { until: Date.now() + CIRCUIT_MS, reason })
}

function providerWithKey(id: GeoProvider): ActiveProvider | null {
  const key = process.env[id === 'amap' ? 'GEO_AMAP_KEY' : 'GEO_GOOGLE_KEY']?.trim() ?? ''
  return key ? { id, key } : null
}

/** auto 优先高德：国内实例可直连；Google 需企业合规跨境通道，显式指定或高德无 Key 时才用 */
export function activeProvider(): ActiveProvider | null {
  const chosen = (process.env.GEO_PROVIDER ?? 'auto').trim().toLowerCase()
  if (chosen === 'none') return null
  if (chosen === 'amap') return providerWithKey('amap')
  if (chosen === 'google') return providerWithKey('google')
  return providerWithKey('amap') ?? providerWithKey('google')
}

/** 统一出网：任何 403/429/风控响应都视为熔断信号，普通网络故障只跳过本次 */
async function fetchGeo(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (response.status === 403 || response.status === 429) {
    throw new AntiBotError(`HTTP ${response.status}`)
  }
  return response
}

async function fetchGeoJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchGeo(url, init)
  const raw = await response.text()
  if (/captcha|验证码|access denied|robot check/i.test(raw.slice(0, 400))) {
    throw new AntiBotError('返回风控校验页面')
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${raw.slice(0, 120)}`)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('返回的不是合法 JSON')
  }
}

function parseLocation(value: unknown): { lng: number; lat: number } | null {
  if (typeof value !== 'string') return null
  const [lng, lat] = value.split(',').map(Number)
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null
}

/** GCJ-02 → WGS-84：高德坐标为国测局偏移坐标，直接给 Google Maps 会有数百米偏差 */
const PI = Math.PI
const AXIS = 6378245.0
const EE = 0.00669342162296594323

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return ret
}

export function gcjToWgs(lng: number, lat: number): { lng: number; lat: number } {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lng, lat }
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI)
  return {
    lng: Number((lng - dLng).toFixed(6)),
    lat: Number((lat - dLat).toFixed(6)),
  }
}

/** 高德关键字搜索；无结果时退一步用地理编码，仍无结果则明确返回 null，不猜测坐标 */
async function amapLookup(name: string, city: string, key: string): Promise<LookupHit | null> {
  const search = new URL('https://restapi.amap.com/v3/place/text')
  search.searchParams.set('keywords', name)
  if (city) search.searchParams.set('city', city)
  search.searchParams.set('offset', '1')
  search.searchParams.set('page', '1')
  search.searchParams.set('extensions', 'base')
  search.searchParams.set('key', key)
  const data = await fetchGeoJson(search.toString())
  const pois = Array.isArray(data.pois) ? (data.pois as Array<Record<string, unknown>>) : []
  const first = pois[0]
  const location = parseLocation(first?.location)
  if (first && location) {
    const wgs = gcjToWgs(location.lng, location.lat)
    return {
      gcjLng: location.lng,
      gcjLat: location.lat,
      ...wgs,
      address: typeof first.address === 'string' && first.address.trim() ? first.address.trim().slice(0, 160) : null,
      poiId: typeof first.id === 'string' ? first.id.slice(0, 60) : null,
    }
  }
  if (data.status === '0') throw new Error(`高德搜索失败：${String(data.info ?? '未知原因').slice(0, 80)}`)

  const geocode = new URL('https://restapi.amap.com/v3/geocode/geo')
  geocode.searchParams.set('address', `${city}${name}`)
  geocode.searchParams.set('key', key)
  const geoData = await fetchGeoJson(geocode.toString())
  const codes = Array.isArray(geoData.geocodes) ? (geoData.geocodes as Array<Record<string, unknown>>) : []
  const hit = parseLocation(codes[0]?.location)
  if (!hit) return null
  const wgs = gcjToWgs(hit.lng, hit.lat)
  return {
    gcjLng: hit.lng,
    gcjLat: hit.lat,
    ...wgs,
    address: typeof codes[0]?.formatted_address === 'string' ? String(codes[0].formatted_address).slice(0, 160) : null,
    poiId: null,
  }
}

/** Google Places API (New) Text Search，返回 WGS-84；海外源在境内实例需合规通道 */
async function googleLookup(name: string, city: string, key: string): Promise<LookupHit | null> {
  const data = await fetchGeoJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
      'x-goog-fieldmask': 'places.id,places.location,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: city ? `${name} ${city}` : name, maxResultCount: 1 }),
  })
  const places = Array.isArray(data.places) ? (data.places as Array<Record<string, unknown>>) : []
  const first = places[0]
  const location = first?.location as Record<string, unknown> | undefined
  const lat = Number(location?.latitude)
  const lng = Number(location?.longitude)
  if (!first || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    gcjLng: null,
    gcjLat: null,
    lng,
    lat,
    address: typeof first.formattedAddress === 'string' ? first.formattedAddress.slice(0, 160) : null,
    poiId: typeof first.id === 'string' ? first.id.slice(0, 60) : null,
  }
}

function attribution(provider: GeoProvider | null): string {
  if (provider === 'amap') {
    return '坐标与地址来自高德地图开放平台（GCJ-02 已转换为 WGS-84 供 Google Maps 使用）；静态地图 © 高德地图，仅在导出时实时取用；深链为高德官方 URI API。'
  }
  if (provider === 'google') {
    return '坐标与地址来自 Google Places API（WGS-84）；静态地图 © Google，仅在导出时实时取用；深链为官方 Maps URLs。'
  }
  return '未配置地图 API Key：地点卡片为系统绘制的示意图（非真实地图，不含坐标）；点击高德 / Google Maps 官方深链可查看精确位置。系统不会编造经纬度或地址。'
}

/** 第一阶段取证：地点名 → 官方深链（必有）+ 可选精确坐标。任何失败都不阻断生成主链路 */
export async function collectGeo(pois: string[], city: string, emit: GenerationEmit): Promise<GeoBundle> {
  const collectedAt = new Date().toISOString()
  const uniquePois = [...new Set(pois.map((item) => item.trim()).filter(Boolean))].slice(0, 8)
  const provider = activeProvider()
  const degraded: string[] = []
  const existingCircuit = provider ? activeCircuit(provider.id) : null
  if (provider && existingCircuit) degraded.push(GEO_PROVIDER_LABELS[provider.id])

  emit({
    type: 'stage',
    stage: 'geo',
    message: provider
      ? `正在通过${GEO_PROVIDER_LABELS[provider.id]}官方 API 核对 ${uniquePois.length} 个地点的定位信息`
      : `正在为 ${uniquePois.length} 个地点生成高德 / Google Maps 官方定位链接`,
    current: 0,
    total: uniquePois.length,
  })
  if (existingCircuit) {
    emit({
      type: 'log',
      stage: 'geo',
      message: `${GEO_PROVIDER_LABELS[provider!.id]}仍在熔断冷却中（${existingCircuit.reason}），本次只生成官方深链`,
    })
  }

  const result: GeoPoi[] = []
  for (let index = 0; index < uniquePois.length; index += 1) {
    const name = uniquePois[index]
    const links = buildDeepLinks(name, city)
    const poi: GeoPoi = {
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
      note: '未取得精确坐标，点击官方地图链接查看位置',
    }

    if (provider && !activeCircuit(provider.id)) {
      try {
        const hit = provider.id === 'amap'
          ? await amapLookup(name, city, provider.key)
          : await googleLookup(name, city, provider.key)
        if (hit) {
          poi.lng = hit.lng
          poi.lat = hit.lat
          poi.gcjLng = hit.gcjLng
          poi.gcjLat = hit.gcjLat
          poi.address = hit.address
          poi.poiId = hit.poiId
          poi.provider = provider.id
          poi.accuracy = 'exact'
          poi.note = `由${GEO_PROVIDER_LABELS[provider.id]}官方 API 核对，定位仅供参考，出行前请在地图 App 复核`
        } else {
          poi.note = '官方 API 未检索到该地点，仅提供地图搜索入口，位置未经核实'
          emit({ type: 'log', stage: 'geo', message: `「${name}」官方 API 无匹配结果，降级为深链` })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof AntiBotError) {
          tripCircuit(provider.id, message)
          degraded.push(GEO_PROVIDER_LABELS[provider.id])
          emit({
            type: 'log',
            stage: 'geo',
            message: `${GEO_PROVIDER_LABELS[provider.id]}触发限流或风控，已熔断 5 分钟并降级为官方深链（不重试）`,
            detail: message,
          })
        } else {
          emit({ type: 'log', stage: 'geo', message: `「${name}」定位服务本次不可用，已降级为深链`, detail: message })
        }
      }
    }
    result.push(poi)
    emit({
      type: 'progress',
      stage: 'geo',
      message: `「${name}」${poi.accuracy === 'exact' ? `已取得精确坐标 ${poi.lat!.toFixed(4)}, ${poi.lng!.toFixed(4)}` : '仅官方深链'}`,
      current: index + 1,
      total: uniquePois.length,
    })
  }

  return {
    city,
    pois: result,
    provider: provider?.id ?? null,
    providerLabel: provider ? GEO_PROVIDER_LABELS[provider.id] : '官方地图深链',
    degraded: [...new Set(degraded)],
    attribution: attribution(provider?.id ?? null),
    collectedAt,
  }
}

/** 只读上下文：坐标与地址由系统取证，模型只能引用、不得编造 */
export function geoPrompt(geo: GeoBundle | null): string {
  if (!geo || !geo.pois.length) {
    return [
      '【地图定位数据】本次未采集任何地点定位信息。',
      '严格禁止写出具体经纬度、门牌号、街道地址、地铁线路号、公交线路号或「步行约 X 分钟」等精确地理数据；',
      '涉及位置时只写行程安排，并提示用户点击指南中的地图链接自行核实。',
    ].join('\n')
  }
  const lines = geo.pois.map((poi) => {
    const coord = poi.accuracy === 'exact' ? `WGS-84 ${poi.lat!.toFixed(5)}, ${poi.lng!.toFixed(5)}` : '未取得精确坐标'
    const address = poi.address ? `地址「${poi.address}」` : '地址未取得'
    const source = poi.accuracy === 'exact' ? GEO_PROVIDER_LABELS[poi.provider!] : '仅官方地图深链'
    return `- ${poi.name}：${coord}；${address}；来源 ${source}`
  })
  return [
    `【地图定位数据：由系统从${geo.providerLabel}取得，非模型生成】`,
    ...lines,
    '',
    '严格约束：',
    '1. 只能引用上面列出的坐标与地址，禁止编造任何门牌号、经纬度、地铁站名、公交线路号或精确步行时长。',
    '2. 标注「未取得精确坐标」的地点，不要写任何具体方位描述；可提示用户点击指南里的高德 / Google Maps 链接查看。',
    '3. 交通建议只做定性描述（如「建议打车」「地铁可达，具体线路请查地图」），不编造线路号与时长。',
    '4. 开放时间、票价、预约方式请以官方渠道为准，不要写成确定事实。',
    geo.degraded.length ? `5. 以下源本次被熔断降级，不要假设它们提供了坐标：${geo.degraded.join('、')}。` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 官方静态地图 URL：密钥只出现在服务端请求里，绝不写进 HTML */
function staticMapRequest(poi: GeoPoi, index: number, key: string): string {
  if (poi.provider === 'google' && poi.lat !== null && poi.lng !== null) {
    const params = new URLSearchParams({
      center: `${poi.lat},${poi.lng}`,
      zoom: '15',
      size: '400x220',
      scale: '1',
      markers: `color:0xD6BC84|label:${index + 1}|${poi.lat},${poi.lng}`,
      key,
    })
    return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
  }
  const lng = poi.gcjLng ?? poi.lng
  const lat = poi.gcjLat ?? poi.lat
  if (lng === null || lat === null) return ''
  const params = new URLSearchParams({
    location: `${lng},${lat}`,
    zoom: '15',
    size: '400*220',
    scale: '1',
    markers: `mid,0xD6BC84,${String.fromCharCode(65 + (index % 26))}:${lng},${lat}`,
    key,
  })
  return `https://restapi.amap.com/v3/staticmap?${params.toString()}`
}

/**
 * 导出 HTML 时实时抓取静态图并转成 data URI 内嵌：文件自包含、离线可看、密钥不外泄。
 * 图片不写入数据库（官方条款普遍禁止缓存地图图片），失败就退回自绘 SVG 示意图。
 */
export async function withStaticImages(geo: GeoBundle | null): Promise<GeoBundle | null> {
  if (!geo || !geo.provider || process.env.GEO_STATIC_MAP !== '1') return geo
  if (activeCircuit(geo.provider)) return geo
  const provider = activeProvider()
  if (!provider || provider.id !== geo.provider) return geo

  const head = await Promise.all(
    geo.pois.slice(0, MAX_IMAGES).map(async (poi, index) => {
      if (poi.accuracy !== 'exact') return poi
      const url = staticMapRequest(poi, index, provider.key)
      if (!url) return poi
      try {
        const response = await fetchGeo(url)
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase()
        if (!response.ok || !/^image\/(png|jpeg|jpg|webp)$/.test(contentType)) {
          throw new Error(`静态地图未返回图片（HTTP ${response.status} / ${contentType || '未知类型'}）`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength > 200_000) throw new Error('静态地图图片过大，已跳过')
        return { ...poi, staticImage: `data:${contentType};base64,${buffer.toString('base64')}` }
      } catch (error) {
        if (error instanceof AntiBotError) tripCircuit(provider.id, error.message)
        return poi
      }
    }),
  )
  return { ...geo, pois: [...head, ...geo.pois.slice(MAX_IMAGES)] }
}
