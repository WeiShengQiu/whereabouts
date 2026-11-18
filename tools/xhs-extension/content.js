/**
 * 行迹 · 小红书线索采集 —— content script
 * 只做一件事：收到 popup 的「采集」消息后，调用页面解析器读 DOM 并返回结果。
 * 不发网络请求、不读 Cookie、不操作页面、不绕过任何风控。
 *
 * 注意：本文件与 parser.js 由 manifest 一起注入到同一个 isolated world。
 * 若因「先于 parser 执行 / 扩展刚更新 / SPA 导航」导致 parser 缺席，
 * 返回明确标记，由 popup 主动注入 parser 后重试。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'XHS_COLLECT') return
  try {
    if (!window.XhsParser || typeof window.XhsParser.collect !== 'function') {
      sendResponse({ ok: false, error: 'PARSER_MISSING' })
      return true
    }
    const payload = window.XhsParser.collect(document)
    sendResponse({ ok: true, data: payload })
  } catch (err) {
    sendResponse({ ok: false, error: (err && err.message) || String(err) })
  }
  return true
})
