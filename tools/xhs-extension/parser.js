/**
 * 行迹 · 小红书线索采集 —— 页面解析器（纯函数，无网络请求）
 *
 * 设计原则：
 * 1. 只读「用户浏览器当前已渲染的 DOM」，不主动发任何请求、不读 Cookie、不碰签名。
 * 2. 小红书 DOM 结构随版本变化，故每个字段用多组选择器兜底；再以 __INITIAL_STATE__ 兜底。
 * 3. 输出固定 schema，供行迹平台「导入扩展数据」消费。
 *
 * 该文件同时支持浏览器（挂到 window.XhsParser）与 Node（module.exports），便于单测。
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.XhsParser = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const SCHEMA_VERSION = 1
  // 与 manifest.json 的 version 保持一致；导出凭证里带上，便于平台识别版本
  const EXT_VERSION = '1.2.0'

  function text(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''
  }

  function attr(el, name) {
    return el && el.getAttribute ? (el.getAttribute(name) || '').trim() : ''
  }

  /** 在候选选择器中取第一个命中的元素 */
  function first(doc, selectors, scope) {
    const base = scope || doc
    for (const sel of selectors) {
      try {
        const found = base.querySelector(sel)
        if (found) return found
      } catch (_) {
        /* 选择器不被支持则跳过 */
      }
    }
    return null
  }

  /** 把可能带「万」「+」的中文计数转成数字 */
  function toCount(value) {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const s = String(value).replace(/,/g, '').trim()
    if (!s) return null
    const m = s.match(/^([\d.]+)\s*万/)
    if (m) return Math.round(parseFloat(m[1]) * 10000)
    const n = parseInt(s.replace(/[^\d]/g, ''), 10)
    return Number.isFinite(n) ? n : null
  }

  /** 规范化笔记链接：只接受小红书域名，相对路径补全 */
  function noteUrl(raw) {
    if (!raw) return ''
    try {
      const url = new URL(raw, 'https://www.xiaohongshu.com')
      if (url.hostname !== 'www.xiaohongshu.com' && url.hostname !== 'xiaohongshu.com') return ''
      url.hash = ''
      return url.toString()
    } catch (_) {
      return ''
    }
  }

  /** 判断页面类型：search / note / unknown */
  function detectPageType(doc) {
    const path = (doc.location && doc.location.pathname) || ''
    if (/\/explore\/\w+/.test(path) || /\/discovery\/item\/\w+/.test(path)) return 'note'
    if (/search_result/.test(path)) return 'search'
    // URL 拿不到时用 DOM 特征兜底
    if (first(doc, ['#note-container', '.note-container', '.note-detail'])) return 'note'
    if (first(doc, ['.feeds-page', '.search-result', '.note-item'])) return 'search'
    return 'unknown'
  }

  /** 从 __INITIAL_STATE__ 里尽力取笔记数据（若版本仍保留） */
  function stateFallback(doc) {
    // querySelector 不支持 :contains，必须逐个扫描 script，且必须确认内容真的含 marker
    let raw = ''
    const scripts = doc.querySelectorAll ? Array.from(doc.querySelectorAll('script')) : []
    for (const s of scripts) {
      const t = s.textContent || ''
      if (t.indexOf('__INITIAL_STATE__') !== -1) { raw = t; break }
    }
    if (!raw) return []
    // 兼容 window.__INITIAL_STATE__ = {...} 与 __INITIAL_STATE__={...} 两种写法
    let idx = raw.indexOf('__INITIAL_STATE__')
    if (idx === -1) return []
    let json = raw.slice(idx + '__INITIAL_STATE__'.length).replace(/^\s*=\s*/, '').replace(/;\s*$/, '').trim()
    // 截到第一个 }; 之后常被前端改写，尽量找完整对象：用括号平衡
    let depth = 0
    let end = -1
    let inStr = false
    let quote = ''
    for (let i = 0; i < json.length; i++) {
      const c = json[i]
      if (inStr) {
        if (c === '\\') { i++; continue }
        if (c === quote) inStr = false
        continue
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end > 0) json = json.slice(0, end)
    let state
    try { state = JSON.parse(json) } catch (_) { return [] }

    const items = []
    const seen = new Set()
    let visited = 0
    const MAX_NODES = 5000 // 防止异常大的 state 拖慢页面
    const collect = (node) => {
      if (!node || typeof node !== 'object' || visited++ > MAX_NODES) return
      if (Array.isArray(node)) { node.forEach(collect); return }
      // 搜索结果：{ note_card: {display_title, user:{nickname}, interact_info:{liked_count}, cover} }
      // 笔记详情：{ noteDetailMap: { <id>: { note: {title, desc, user, interactInfo} } } }
      const card = node.note_card || node.noteCard ||
        (node.note && (node.note.title || node.note.displayTitle) ? node.note : null) ||
        (node.display_title || node.title ? node : null)
      if (card && (card.display_title || card.title || card.displayTitle)) {
        const id = node.id || node.note_id || node.noteId || card.note_id || card.noteId || ''
        const interact = card.interact_info || card.interactInfo || {}
        const title = textFromAny(card.display_title || card.displayTitle || card.title)
        const link = id ? noteUrl('/explore/' + id) : ''
        const key = title + '|' + link
        if (!seen.has(key)) {
          seen.add(key)
          items.push({
            title,
            author: textFromAny((card.user && (card.user.nickname || card.user.nickName)) || node.user?.nickname || ''),
            likes: toCount(interact.liked_count || interact.likedCount || card.liked_count || null),
            collects: toCount(interact.collected_count || interact.collectedCount || null),
            comments: toCount(interact.comment_count || interact.commentCount || null),
            cover: String((card.cover && (card.cover.url_default || card.cover.url || card.cover.urlDefault)) || ''),
            summary: textFromAny(card.desc || card.description || '').slice(0, 500),
            link,
            source: 'initial_state',
          })
        }
        // 已把 card 整体提取，其内部字段（user/cover/interact_info）不可能是独立笔记，停止下钻避免重复
        return
      }
      // 对象节点未命中，继续下钻（search.feeds[].note_card 就藏在这一层）
      for (const value of Object.values(node)) collect(value)
    }
    collect(state.search)
    collect(state.feed)
    collect(state.note)
    return items.slice(0, 50)
  }

  function textFromAny(v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') return textFromAny(v.text || v.default || '')
    return String(v).replace(/\s+/g, ' ').trim()
  }

  /** 搜索页：提取当前可见的笔记卡片 */
  function parseSearchPage(doc) {
    const cardSelectors = [
      '.note-item', '.search-result .note-item', 'section.note-item',
      '[class*="note-item"]', '.feeds-container > div',
    ]
    let cards = []
    for (const sel of cardSelectors) {
      try {
        const found = Array.from(doc.querySelectorAll(sel))
        if (found.length > cards.length) cards = found
      } catch (_) { /* skip */ }
    }
    const items = cards.map((card) => {
      const titleEl = first(doc, [
        '.title span', '.title', 'a.title', '[class*="title"] span',
        '.footer .title', 'span.title',
      ], card)
      const authorEl = first(doc, [
        '.author .name', '.author', '.nickname', '[class*="author"] span',
        '.user .name',
      ], card)
      const likeEl = first(doc, [
        '.like-wrapper .count', '.count', '[class*="like"] .count',
        '.interact-info .count', 'span.count',
      ], card)
      const linkEl = first(doc, ['a.cover', 'a[href*="/explore/"]', 'a[href*="/discovery/item/"]', 'a'], card)
      const coverEl = first(doc, ['img.cover', 'img[src*="xhscdn"]', 'cover img', 'img'], card)
      const href = linkEl ? (attr(linkEl, 'href') || '') : ''
      const idMatch = href.match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i)
      return {
        title: text(titleEl),
        author: text(authorEl),
        likes: toCount(text(likeEl)),
        collects: null,
        comments: null,
        cover: coverEl ? (attr(coverEl, 'src') || attr(coverEl, 'data-src') || '') : '',
        link: idMatch ? noteUrl('/explore/' + idMatch[1]) : noteUrl(href),
        source: 'dom',
      }
    }).filter((it) => it.title || it.link)

    if (items.length) return dedupe(items)
    return dedupe(stateFallback(doc))
  }

  /** 笔记详情页：提取当前这篇笔记 */
  function parseNotePage(doc) {
    const titleEl = first(doc, [
      '#detail-title', '.note-title', '.title', 'h1',
      '[class*="note-title"]', '[class*="title"]',
    ])
    const descEl = first(doc, [
      '#detail-desc', '.note-text', '.desc', '[class*="desc"]',
      '.content', '.note-content',
    ])
    const authorEl = first(doc, [
      '.author .username', '.username', '.author', '[class*="author"]',
    ])
    const dateEl = first(doc, ['.date', '.publish-date', '[class*="date"]'])
    const likeEl = first(doc, ['.like-wrapper .count', '.count', '[class*="like"] .count'])
    const collectEl = first(doc, ['.collect-wrapper .count', '[class*="collect"] .count'])
    const commentEl = first(doc, ['.chat-wrapper .count', '[class*="comment"] .count', '#comments .count'])
    const coverEl = first(doc, ['.note-slider img', '.swiper-slide img', 'img[src*="xhscdn"]'])

    const path = (doc.location && doc.location.pathname) || ''
    const idMatch = path.match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i)

    const stateItems = idMatch ? [] : stateFallback(doc)
    const fromState = stateItems[0]

    return [{
      title: text(titleEl) || (fromState && fromState.title) || '',
      author: text(authorEl) || (fromState && fromState.author) || '',
      likes: toCount(text(likeEl)) || (fromState && fromState.likes) || null,
      collects: toCount(text(collectEl)) || (fromState && fromState.collects) || null,
      comments: toCount(text(commentEl)) || (fromState && fromState.comments) || null,
      cover: coverEl ? (attr(coverEl, 'src') || '') : (fromState && fromState.cover) || '',
      link: (idMatch ? noteUrl('/explore/' + idMatch[1]) : (doc.location && doc.location.href) || '') || (fromState && fromState.link) || '',
      summary: text(descEl).slice(0, 500),
      publishedAt: text(dateEl).slice(0, 40),
      source: 'dom',
    }].filter((it) => it.title || it.summary || it.link)
  }

  function dedupe(items) {
    const seen = new Set()
    return items.filter((it) => {
      const key = it.link || it.title
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /**
   * 检测小红书登录态：只读当前页面 DOM，不读 Cookie。
   * 依据：已登录时页面有用户头像/昵称入口；未登录时有「登录」按钮或登录弹层。
   * 返回 true / false / null（无法判断）。
   */
  function detectLogin(doc) {
    const loggedInSelectors = [
      '.user-info', '.user .name', '.reds-avatar', '.side-bar .user',
      '[class*="user-info"]', '[class*="avatar-item"]', '.channel-user-info',
      'a[href*="/user/profile/"]',
    ]
    for (const sel of loggedInSelectors) {
      try {
        const el = doc.querySelector(sel)
        if (el && text(el)) return true
      } catch (_) { /* 忽略不支持的选择器 */ }
    }
    // 从 __INITIAL_STATE__ 判断（若版本保留 user 信息）
    try {
      const scripts = doc.querySelectorAll ? Array.from(doc.querySelectorAll('script')) : []
      for (const s of scripts) {
        const t = s.textContent || ''
        if (t.indexOf('__INITIAL_STATE__') === -1) continue
        if (/"user"[^}]{0,200}"(nickname|nickName|userId|redId)"/.test(t)) return true
      }
    } catch (_) { /* ignore */ }
    const loginPrompts = ['登录', 'Log in', 'Sign in']
    const btnSelectors = ['.login-btn', '[class*="login-btn"]', 'button', '[role="button"]']
    let hasLoginButton = false
    for (const sel of btnSelectors) {
      try {
        for (const el of Array.from(doc.querySelectorAll(sel)).slice(0, 40)) {
          const t = text(el)
          if (t && t.length <= 12 && loginPrompts.some((p) => t.includes(p))) { hasLoginButton = true; break }
        }
      } catch (_) { /* ignore */ }
      if (hasLoginButton) return false
    }
    // DOCTYPE/空壳页无法判断
    return null
  }

  /** 主入口：返回符合行迹导入 schema 的导出包（带登录凭证） */
  function collect(doc) {
    const pageType = detectPageType(doc)
    const loginState = detectLogin(doc)
    let items = []
    if (pageType === 'search') items = parseSearchPage(doc)
    else if (pageType === 'note') items = parseNotePage(doc)
    else items = dedupe(stateFallback(doc))

    return {
      schemaVersion: SCHEMA_VERSION,
      app: '行迹 · 小红书线索采集',
      pageType,
      collectedAt: new Date().toISOString(),
      pageUrl: (doc.location && doc.location.href) || '',
      // 登录凭证：只有明确检测到已登录才置 true，平台据此做硬门禁
      loginChecked: loginState !== null,
      loggedIn: loginState === true,
      extensionVersion: EXT_VERSION,
      count: items.length,
      items,
      notice: items.length
        ? '数据来自你当前浏览器已登录页面可见内容，仅作人工核对线索，不产生评分。'
        : loginState === false
          ? '检测到你尚未登录小红书，请先登录再采集。'
          : '未识别到笔记数据。请确认已登录小红书且页面已加载出笔记，再重试。',
    }
  }

  return {
    SCHEMA_VERSION,
    EXT_VERSION,
    detectPageType,
    detectLogin,
    parseSearchPage,
    parseNotePage,
    stateFallback,
    collect,
    toCount,
    noteUrl,
    dedupe,
  }
})
