/* 行迹 · 小红书线索采集 —— popup 交互：在已登录页面读取 DOM，展示并导出 JSON
 * 关键点：不依赖「扩展安装前就已打开的标签页」自动注入的 content script。
 * popup 每次采集都主动用 scripting API 注入 parser.js，再在页面上下文调用 collect，
 * 这样「刚装完/刚更新扩展、页面已开着」也能一次成功。全程只读 DOM，不发网络请求。 */
(function () {
  const $ = (id) => document.getElementById(id)
  const statusEl = $('status')
  const listEl = $('list')
  const collectBtn = $('collect')
  const copyBtn = $('copy')
  const downloadBtn = $('download')
  let lastPayload = null

  function setStatus(msg, kind) {
    statusEl.textContent = msg
    statusEl.className = 'status' + (kind ? ' ' + kind : '')
  }

  function render(payload) {
    listEl.innerHTML = ''
    payload.items.forEach((it) => {
      const div = document.createElement('div')
      div.className = 'item'
      const a = document.createElement('a')
      a.textContent = it.title || '（无标题）'
      a.href = it.link || '#'
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      const meta = document.createElement('div')
      meta.className = 'meta'
      const bits = [it.author, it.likes !== null ? '赞 ' + it.likes : '', it.pageType || ''].filter(Boolean)
      meta.textContent = bits.join(' · ')
      div.appendChild(a)
      div.appendChild(meta)
      listEl.appendChild(div)
    })
  }

  function activeTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return reject(new Error('无法获取当前标签页'))
        resolve(tabs[0])
      })
    })
  }

  /** 在当前标签页注入解析器并采集；注入是幂等的，重复点击不会叠加副作用 */
  async function collectInTab(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['parser.js'] })
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.XhsParser.collect(document),
    })
    if (!results || !results[0] || !results[0].result) throw new Error('NO_RESULT')
    return results[0].result
  }

  collectBtn.addEventListener('click', async () => {
    lastPayload = null
    copyBtn.disabled = true
    downloadBtn.disabled = true
    listEl.innerHTML = ''
    setStatus('采集中…')
    try {
      const tab = await activeTab()
      if (!/^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || '')) {
        setStatus('请先在浏览器中打开小红书的搜索页或笔记详情页。', 'err')
        return
      }
      const data = await collectInTab(tab.id)
      lastPayload = data
      setStatus(data.count ? ('已采集 ' + data.count + ' 条笔记。' + data.notice) : data.notice,
        data.count ? 'ok' : 'err')
      render(data)
      copyBtn.disabled = data.count === 0
      downloadBtn.disabled = data.count === 0
    } catch (err) {
      const msg = (err && err.message) || String(err)
      const tip = /cannot be scripted|chrome:\/\/|edge:\/\//i.test(msg)
        ? '浏览器不允许在扩展/设置页注入脚本，请打开小红书页面后重试。'
        : '采集失败：' + msg
      setStatus(tip, 'err')
    }
  })

  copyBtn.addEventListener('click', async () => {
    if (!lastPayload) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastPayload, null, 2))
      setStatus('JSON 已复制到剪贴板，回到行迹平台粘贴即可。', 'ok')
    } catch (_) {
      setStatus('复制失败，请改用「下载 JSON」。', 'err')
    }
  })

  downloadBtn.addEventListener('click', () => {
    if (!lastPayload) return
    const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'xhs-leads-' + new Date().toISOString().slice(0, 10) + '.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setStatus('JSON 已下载。', 'ok')
  })
})()
