/* 行迹 · 小红书线索采集 —— popup 交互：发消息给 content script，展示并导出结果 */
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
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'XHS_COLLECT' })
      if (!res || !res.ok) {
        setStatus('采集失败：' + ((res && res.error) || '未知错误'), 'err')
        return
      }
      lastPayload = res.data
      setStatus(res.data.count ? ('已采集 ' + res.data.count + ' 条笔记。' + res.data.notice) : res.data.notice,
        res.data.count ? 'ok' : 'err')
      render(res.data)
      copyBtn.disabled = res.data.count === 0
      downloadBtn.disabled = res.data.count === 0
    } catch (err) {
      const msg = (err && err.message) || String(err)
      setStatus(/Receiving end does not exist|Could not establish connection/i.test(msg)
        ? '页面脚本未就绪，请刷新小红书页面后重试。'
        : '采集失败：' + msg, 'err')
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
