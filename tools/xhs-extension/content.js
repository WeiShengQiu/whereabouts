/**
 * 行迹 · 小红书线索采集 —— content script
 * 只做一件事：收到 popup 的「采集」消息后，调用页面解析器读 DOM 并返回结果。
 * 不发网络请求、不读 Cookie、不操作页面、不绕过任何风控。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'XHS_COLLECT') return
  try {
    const payload = window.XhsParser.collect(document)
    sendResponse({ ok: true, data: payload })
  } catch (err) {
    sendResponse({ ok: false, error: (err && err.message) || String(err) })
  }
  return true
})
