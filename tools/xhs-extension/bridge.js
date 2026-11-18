/**
 * 行迹 · 小红书线索采集 —— 平台页桥接（content script）
 *
 * 关键修正（v1.3.0）：content script 运行在 Chrome 的 isolated world，
 * 向 window 挂自定义属性（window.__XHS_COLLECTOR__）对网页里的 React 代码**不可见**。
 * 这正是「装了扩展仍提示未安装」的根因。跨 world 唯一可靠的通道是共享 DOM 上的
 * window.postMessage，所以本文件改为纯消息握手：
 *   页面 → 扩展：{ __xhsBridge: 'req', type: 'PING'|'CHECK_LOGIN'|'COLLECT_ONE', requestId, ... }
 *   扩展 → 页面：{ __xhsBridge: 'res', type: 'STATUS'|'CHECK_LOGIN_RESULT'|'COLLECT_ONE_RESULT', requestId, ... }
 *
 * 不采集数据本身、不发网络请求、不读 Cookie。真正的采集由 background 在用户已登录的小红书标签页里完成。
 */
;(function () {
  const VERSION = '1.3.0'
  const TAG = '__xhsBridge'

  const state = {
    installed: true,
    version: VERSION,
    lastLoginState: null, // null=尚未检测 / true / false
    lastCheckedAt: '',
  }

  // 兼容旧自检：隔离世界内仍挂一个标记；注意网页 JS 读不到它，仅供扩展自身上下文使用
  try {
    Object.defineProperty(window, '__XHS_COLLECTOR__', {
      value: state,
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch (_) { /* 已定义时忽略 */ }

  /** 向页面（main world）广播消息 */
  const post = (type, extra) => {
    try {
      window.postMessage(Object.assign({ [TAG]: 'res', type }, extra || {}), '*')
    } catch (_) { /* 页面已卸载时忽略 */ }
  }

  const postStatus = () => post('STATUS', {
    installed: true,
    version: state.version,
    lastLoginState: state.lastLoginState,
    lastCheckedAt: state.lastCheckedAt,
  })

  // 接收页面请求。只接受来自同窗口、带本扩展标记的消息，避免被第三方脚本误触发
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data[TAG] !== 'req') return

    const type = data.type
    const requestId = data.requestId
    if (type === 'PING') {
      postStatus()
      return
    }
    if (type !== 'CHECK_LOGIN' && type !== 'COLLECT_ONE') return

    try {
      const message = { type: type === 'CHECK_LOGIN' ? 'XHS_CHECK_LOGIN' : 'XHS_COLLECT_ONE' }
      if (type === 'COLLECT_ONE') {
        message.keyword = String(data.keyword || '').slice(0, 120)
        message.category = String(data.category || '')
      }
      chrome.runtime.sendMessage(message, (resp) => {
        post(type + '_RESULT', Object.assign({ requestId, ok: !!(resp && resp.ok) }, resp || {}))
      })
    } catch (err) {
      post(type + '_RESULT', {
        requestId,
        ok: false,
        error: (err && err.message) || String(err),
      })
    }
  })

  // 登录态来自 popup 手动采集或后台自动采集；任一处更新都同步给页面检查项
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['xhsLastLoginState', 'xhsLastCheckedAt'], (data) => {
        if (typeof data.xhsLastLoginState === 'boolean') state.lastLoginState = data.xhsLastLoginState
        if (typeof data.xhsLastCheckedAt === 'string') state.lastCheckedAt = data.xhsLastCheckedAt
        postStatus()
      })
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        if (changes.xhsLastLoginState) state.lastLoginState = changes.xhsLastLoginState.newValue
        if (changes.xhsLastCheckedAt) state.lastCheckedAt = changes.xhsLastCheckedAt.newValue
        postStatus()
      })
    }
  } catch (_) { /* storage 不可用时仍完成握手 */ }

  // 页面可能比 content script 先渲染：页面侧会主动 PING，这里也先广播一次
  postStatus()
})()
