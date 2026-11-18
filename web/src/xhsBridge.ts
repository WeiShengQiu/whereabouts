/**
 * 平台页 ↔ 小红书采集扩展 的 postMessage 协议客户端。
 *
 * 背景：扩展的 content script 运行在 isolated world，写 window 属性网页读不到；
 * 因此 v1.3 起统一用 window.postMessage 握手（见 tools/xhs-extension/bridge.js）。
 *
 * 本模块把「检测扩展 → 检测登录 → 拆检索词 → 逐条自动采集 → 自动导入」串成一条链，
 * 由「生成定制方案」按钮触发；用户只需在首次使用时登录一次小红书。
 */
import { api } from './api'
import type { ResearchQuery, XhsCollectorStatus } from '../../shared/types'

const TAG = '__xhsBridge'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let seq = 0

interface BridgeMessage {
  [key: string]: unknown
  __xhsBridge?: string
  type?: string
  requestId?: string
  ok?: boolean
  installed?: boolean
  version?: string
  lastLoginState?: boolean | null
  lastCheckedAt?: string
  reason?: string
  error?: string
  data?: CollectPayload
  loggedIn?: boolean
  loginChecked?: boolean
}

/** 扩展采集结果（与 tools/xhs-extension/parser.js 的 collect() 输出对齐） */
interface CollectPayload {
  loginChecked?: boolean
  loggedIn?: boolean
  collectedAt?: string
  extensionVersion?: string
  count?: number
  items: Array<{
    title?: string
    author?: string
    likes?: number | null
    summary?: string
    link?: string
  }>
}

export interface AutoProgress {
  phase: 'detect' | 'login' | 'queries' | 'collect' | 'done'
  message: string
  current?: number
  total?: number
  keyword?: string
  imported?: number
}

export interface AutoResearchResult {
  attempted: boolean
  ok: boolean
  reason?: 'NO_EXTENSION' | 'NOT_LOGGED_IN' | 'NO_ITEMS' | 'ERROR'
  message: string
  imported: number
  queries: ResearchQuery[]
  loggedIn: boolean | null
}

/** 向页面自身发进度事件，ResearchPanel 无需与 PlannerPage 层层传 props */
function emitProgress(progress: AutoProgress): void {
  window.dispatchEvent(new CustomEvent<AutoProgress>('xhs-auto-progress', { detail: progress }))
}

const RESPONSE_TYPE: Record<string, string> = {
  PING: 'STATUS',
  CHECK_LOGIN: 'CHECK_LOGIN_RESULT',
  COLLECT_ONE: 'COLLECT_ONE_RESULT',
}

/** 发一条请求并等对应回包；超时明确报错，避免界面永久卡住 */
function ask(type: string, extra: Record<string, unknown>, timeoutMs: number): Promise<BridgeMessage> {
  return new Promise((resolve, reject) => {
    const requestId = `req-${Date.now()}-${++seq}`
    const expected = RESPONSE_TYPE[type]
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return
      const data = event.data as BridgeMessage | null
      if (!data || data[TAG] !== 'res' || data.type !== expected) return
      if (data.requestId && data.requestId !== requestId) return
      cleanup()
      resolve(data)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`扩展响应超时（${type}）`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ [TAG]: 'req', type, requestId, ...extra }, '*')
  })
}

/** 检测扩展：页面可能先于 content script 渲染，所以重试几轮 */
export async function detectCollector(): Promise<XhsCollectorStatus> {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await ask('PING', {}, 1200)
      if (res.installed) {
        const status: XhsCollectorStatus = {
          installed: true,
          version: typeof res.version === 'string' ? res.version : '',
          lastLoginState: res.lastLoginState ?? null,
        }
        window.dispatchEvent(new CustomEvent<XhsCollectorStatus>('xhs-auto-status', { detail: status }))
        return status
      }
    } catch (_) { /* 下一轮重试 */ }
    await sleep(450)
  }
  return { installed: false, version: '', lastLoginState: null }
}

/** 订阅扩展主动广播的状态（登录态在另一个标签页采集后会更新） */
export function onCollectorStatus(callback: (status: XhsCollectorStatus) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as BridgeMessage | null
    if (!data || data[TAG] !== 'res' || data.type !== 'STATUS') return
    callback({
      installed: data.installed === true,
      version: typeof data.version === 'string' ? data.version : '',
      lastLoginState: data.lastLoginState ?? null,
    })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/** 订阅自动采集进度（供 ResearchPanel 展示） */
export function onAutoProgress(callback: (progress: AutoProgress) => void): () => void {
  const handler = (event: Event) => callback((event as CustomEvent<AutoProgress>).detail)
  window.addEventListener('xhs-auto-progress', handler)
  return () => window.removeEventListener('xhs-auto-progress', handler)
}

export function onAutoQueries(callback: (queries: ResearchQuery[]) => void): () => void {
  const handler = (event: Event) => callback((event as CustomEvent<{ queries: ResearchQuery[] }>).detail.queries)
  window.addEventListener('xhs-auto-queries', handler)
  return () => window.removeEventListener('xhs-auto-queries', handler)
}

let running = false

/** 完整自动实采流程；任何一步失败都只降级、不阻断主方案生成 */
export async function runAutoResearch(requirement: string, configId: string, model: string): Promise<AutoResearchResult> {
  const empty: AutoResearchResult = { attempted: false, ok: false, message: '', imported: 0, queries: [], loggedIn: null }
  if (running) return { ...empty, message: '已有自动采集任务在执行，本次跳过。' }
  running = true

  try {
    emitProgress({ phase: 'detect', message: '正在检测采集扩展…' })
    const collector = await detectCollector()
    if (!collector.installed) {
      const message = '未检测到采集扩展：请在自己的 Chrome/Edge 加载 tools/xhs-extension/（WorkBuddy 内置预览窗口无法加载扩展）。本次跳过实采。'
      emitProgress({ phase: 'done', message })
      return { ...empty, reason: 'NO_EXTENSION', message }
    }

    emitProgress({ phase: 'login', message: '正在检查小红书登录态（首次会短暂打开一个后台标签页）…' })
    let loginOk = false
    try {
      const res = await ask('CHECK_LOGIN', {}, 28000)
      loginOk = res.ok === true && res.loggedIn === true
      if (!loginOk && res.reason === 'NOT_LOGGED_IN') {
        const message = '检测到小红书尚未登录：请先在你的浏览器登录一次小红书，再点生成方案即可自动采集。本次跳过实采。'
        emitProgress({ phase: 'done', message })
        return { ...empty, reason: 'NOT_LOGGED_IN', message, loggedIn: false }
      }
    } catch (_) {
      // 首页检测失败不直接放弃：后面的搜索页采集还能再判断一次登录态
    }

    emitProgress({ phase: 'queries', message: '正在按需求拆解酒店/交通/饮食/景点检索词…' })
    const { queries } = await api.researchQueries(requirement.trim(), configId, model.trim())
    window.dispatchEvent(new CustomEvent('xhs-auto-queries', { detail: { queries } }))
    // 每类最多 2 条、总计最多 8 条，控制对用户浏览器的打扰
    const perCategory = new Map<string, number>()
    const selected = queries.filter((q) => {
      const count = perCategory.get(q.category) ?? 0
      if (count >= 2) return false
      perCategory.set(q.category, count + 1)
      return true
    }).slice(0, 8)
    if (selected.length === 0) {
      const message = '未生成可用检索词，本次跳过实采。'
      emitProgress({ phase: 'done', message })
      return { ...empty, message, loggedIn: loginOk }
    }

    let imported = 0
    let sawLogin = false
    for (let i = 0; i < selected.length; i++) {
      const query = selected[i]
      emitProgress({
        phase: 'collect',
        message: `自动采集中 ${i + 1}/${selected.length}：${query.keyword}`,
        current: i + 1,
        total: selected.length,
        keyword: query.keyword,
        imported,
      })
      try {
        const res = await ask('COLLECT_ONE', { keyword: query.keyword, category: query.category }, 35000)
        if (res.data) sawLogin = res.data.loginChecked === true || sawLogin
        if (res.reason === 'NOT_LOGGED_IN') {
          const message = '小红书未登录，已停止后续采集。登录后再次生成方案即可自动采集。'
          emitProgress({ phase: 'done', message, imported })
          return { ...empty, attempted: true, reason: 'NOT_LOGGED_IN', message, imported, queries: selected, loggedIn: false }
        }
        if (res.ok === true && res.data) {
          const result = await api.importResearch(query.category, query.keyword, res.data)
          imported += result.imported
          emitProgress({
            phase: 'collect',
            message: `${query.keyword}：新增 ${result.imported} 条线索`,
            current: i + 1,
            total: selected.length,
            keyword: query.keyword,
            imported,
          })
        }
      } catch (_) {
        // 单条失败继续下一条，不能因为一个关键词卡住整个方案生成
      }
      await sleep(700)
    }

    const message = imported > 0
      ? `自动采集完成：新增 ${imported} 条小红书线索，已注入本次方案。`
      : '自动采集完成但未获得可用线索，方案仍会正常生成（可登录小红书后重试）。'
    emitProgress({ phase: 'done', message, imported, total: selected.length })
    return {
      attempted: true,
      ok: imported > 0,
      reason: imported > 0 ? undefined : 'NO_ITEMS',
      message,
      imported,
      queries: selected,
      loggedIn: loginOk || sawLogin,
    }
  } catch (e) {
    const message = `自动采集失败：${e instanceof Error ? e.message : String(e)}。方案仍会正常生成。`
    emitProgress({ phase: 'done', message })
    return { ...empty, reason: 'ERROR', message }
  } finally {
    running = false
  }
}
