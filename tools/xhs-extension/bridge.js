/**
 * 行迹 · 小红书线索采集 —— 平台页桥接（content script）
 * 只做一件事：向平台页面暴露「扩展已安装」标记与最近一次小红书登录态，
 * 让平台能在用户采集前显示检查项。不采集数据、不发网络请求、不读 Cookie。
 *
 * 注入到平台域名（localhost / 127.0.0.1 / 线上 IP），由 manifest 的第二个 content_scripts 块声明。
 */
;(function () {
  const VERSION = '1.2.0'

  // 初始化标记：扩展存在即 installed=true
  const marker = {
    installed: true,
    version: VERSION,
    lastLoginState: null, // null=尚未采集过 / true / false
    lastCheckedAt: '',
  }
  Object.defineProperty(window, '__XHS_COLLECTOR__', {
    value: marker,
    writable: false,
    configurable: false,
    enumerable: false,
  })

  // 通知平台页：检查项状态更新了
  const notify = () => {
    window.dispatchEvent(new CustomEvent('xhs-collector-status', { detail: { ...marker } }))
  }

  // 从扩展共享存储读取最近一次采集时的登录态
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['xhsLastLoginState', 'xhsLastCheckedAt'], (data) => {
        if (typeof data.xhsLastLoginState === 'boolean') marker.lastLoginState = data.xhsLastLoginState
        if (typeof data.xhsLastCheckedAt === 'string') marker.lastCheckedAt = data.xhsLastCheckedAt
        notify()
      })
      // 采集后 popup 会更新存储，实时同步到已打开的平台页
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        if (changes.xhsLastLoginState) marker.lastLoginState = changes.xhsLastLoginState.newValue
        if (changes.xhsLastCheckedAt) marker.lastCheckedAt = changes.xhsLastCheckedAt.newValue
        notify()
      })
    }
  } catch (_) {
    // storage 不可用时仍暴露 installed 标记
  }

  notify()
})()
