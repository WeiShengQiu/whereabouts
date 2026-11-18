/**
 * 行迹 · 小红书线索采集 —— 后台 service worker
 * 仅做两件无害的事：安装时打开一次性说明页、为 popup 提供扩展 ID 自检。
 * 不联网、不收集数据、不读写 Cookie、不参与采集逻辑。
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 首次安装给出使用提示（不自动跳转小红书，避免打扰）
    console.info('[行迹] 小红书线索采集扩展已安装。请在已登录的小红书页面点击工具栏图标采集。')
  }
})
