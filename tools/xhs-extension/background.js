/**
 * 行迹 · 小红书线索采集 —— 后台 service worker（v1.4.0）
 *
 * 职责：
 * 1. 平台页通过 bridge 发来 CHECK_LOGIN / COLLECT_ONE；
 * 2. 后台在**用户自己的浏览器**里静默开一个非活动标签页打开小红书搜索页，
 *    注入只读解析器读取当前已渲染 DOM，收集完立刻关闭标签页；
 * 3. 结果回传平台页，由平台页自动导入后端并注入模型。
 *
 * 合规边界：不代用户发请求、不读 Cookie、不碰签名、不绕过风控；只用用户浏览器已登录的页面。
 * 采集频率由前端串行控制（每条间隔 >=600ms），后台再加 busy 锁防止并发。
 */
const XHS_ORIGIN = 'https://www.xiaohongshu.com'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let busy = false

/** 等待标签页加载完成，避免 SPA 还没渲染就采集 */
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      clearTimeout(timer)
      resolve(value)
    }
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return finish(false)
      if (tab.status === 'complete') finish(true)
    })
    const timer = setTimeout(() => finish(false), timeoutMs || 12000)
  })
}

/** 在指定标签页注入只读解析器并读取 DOM；结果为空时短暂重试（SPA 渲染慢） */
async function injectAndCollect(tabId, attempts) {
  let last = null
  let lastError = ''
  for (let i = 0; i < (attempts || 3); i++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['parser.js'] })
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          if (!window.XhsParser || typeof window.XhsParser.collect !== 'function') return null
          return window.XhsParser.collect(document)
        },
      })
      const payload = results && results[0] && results[0].result
      if (payload && payload.count > 0) return payload
      if (payload) last = payload
    } catch (err) {
      lastError = (err && err.message) || String(err)
    }
    await sleep(1500)
  }
  return last || {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    loginChecked: false,
    loggedIn: false,
    count: 0,
    items: [],
    notice: lastError ? '注入解析器失败：' + lastError : '页面未渲染出笔记卡片',
  }
}

/** 创建非活动标签页 → 等加载 → 采集 → 关掉，并把登录态同步给平台页 */
async function withXhsTab(url, read) {
  const tab = await chrome.tabs.create({ url, active: false })
  try {
    await waitTabComplete(tab.id, 12000)
    await sleep(1200) // 给小红书 SPA 一点渲染时间
    return await read(tab.id)
  } finally {
    try { await chrome.tabs.remove(tab.id) } catch (_) { /* 用户已手动关闭 */ }
  }
}

/** 只检测登录：打开首页读 DOM 特征，不采集笔记 */
async function checkLogin() {
  return withXhsTab(XHS_ORIGIN + '/explore', async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['parser.js'] })
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        loginChecked: window.XhsParser.detectLogin(document) !== null,
        loggedIn: window.XhsParser.detectLogin(document) === true,
      }),
    })
    const state = (results && results[0] && results[0].result) || { loginChecked: false, loggedIn: false }
    await chrome.storage.local.set({
      xhsLastLoginState: state.loggedIn,
      xhsLastCheckedAt: new Date().toISOString(),
    })
    return state
  })
}

/** 按关键词采集小红书搜索页的可见笔记 */
async function collectOne(keyword) {
  const url = XHS_ORIGIN + '/search_result?keyword=' + encodeURIComponent(keyword || '')
  return withXhsTab(url, async (tabId) => {
    const payload = await injectAndCollect(tabId, 3)
    await chrome.storage.local.set({
      xhsLastLoginState: payload.loggedIn === true,
      xhsLastCheckedAt: payload.collectedAt || new Date().toISOString(),
    })
    return payload
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || (message.type !== 'XHS_CHECK_LOGIN' && message.type !== 'XHS_COLLECT_ONE')) return false
  if (busy) {
    sendResponse({ ok: false, reason: 'BUSY' })
    return false
  }
  busy = true
  ;(async () => {
    try {
      if (message.type === 'XHS_CHECK_LOGIN') {
        const state = await checkLogin()
        if (!state.loggedIn) sendResponse({ ok: false, reason: 'NOT_LOGGED_IN', ...state })
        else sendResponse({ ok: true, ...state })
        return
      }
      const payload = await collectOne(String(message.keyword || '').slice(0, 120))
      if (!payload.loginChecked || !payload.loggedIn) {
        sendResponse({ ok: false, reason: 'NOT_LOGGED_IN', data: payload })
      } else if (!payload.count) {
        sendResponse({ ok: false, reason: 'NO_ITEMS', data: payload })
      } else {
        // 单关键词最多 12 条：前端按 30–50 条的总量控制，这里只限制单次体积
        sendResponse({ ok: true, data: Object.assign({}, payload, { items: payload.items.slice(0, 12) }) })
      }
    } catch (err) {
      sendResponse({ ok: false, reason: 'ERROR', error: (err && err.message) || String(err) })
    } finally {
      busy = false
    }
  })()
  return true // 异步回包必须保持消息通道
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.info('[行迹] 采集扩展已就绪。在平台页生成方案时会自动检测扩展与小红书登录态。')
  }
})
