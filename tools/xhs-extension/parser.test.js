/* 行迹 · 小红书线索采集解析器单测（Node 内置断言，无需第三方依赖） */
const assert = require('node:assert/strict')
const P = require('./parser.js')

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

// 轻量 DOM stub：够 parser 的 querySelector / getAttribute / textContent 用
function el(attrs = {}, children = []) {
  return {
    attrs, children,
    textContent: children.map((c) => (typeof c === 'string' ? c : c.textContent || '')).join(' '),
    getAttribute(k) { return this.attrs[k] || '' },
    querySelector(sel) { return findByClass(this, sel) || null },
    querySelectorAll(sel) { return findAllByClass(this, sel) },
  }
}
function findByClass(node, sel) {
  const cls = (sel.match(/\.([\w-]+)/) || [])[1]
  if (!cls) return null
  for (const c of node.children || []) {
    if (typeof c === 'string') continue
    const list = (c.attrs && c.attrs.class || '').split(/\s+/)
    if (list.includes(cls)) return c
    const deep = findByClass(c, sel)
    if (deep) return deep
  }
  return null
}
function findAllByClass(node, sel) {
  const out = []
  const cls = (sel.match(/\.([\w-]+)/) || [])[1]
  const walk = (n) => {
    for (const c of n.children || []) {
      if (typeof c === 'string') continue
      const list = (c.attrs && c.attrs.class || '').split(/\s+/)
      if (cls && list.includes(cls)) out.push(c)
      walk(c)
    }
  }
  walk(node)
  return out
}

console.log('解析器单测：')

check('toCount：普通数字 / 万 / 空值', () => {
  assert.equal(P.toCount('123'), 123)
  assert.equal(P.toCount('1.2万'), 12000)
  assert.equal(P.toCount('3,456'), 3456)
  assert.equal(P.toCount(''), null)
  assert.equal(P.toCount(null), null)
})

check('noteUrl：只放行小红书域名，补全相对路径，去掉 hash', () => {
  assert.equal(P.noteUrl('/explore/abc123'), 'https://www.xiaohongshu.com/explore/abc123')
  assert.equal(P.noteUrl('https://evil.com/explore/x'), '')
  assert.equal(P.noteUrl('https://www.xiaohongshu.com/explore/def#x'), 'https://www.xiaohongshu.com/explore/def')
})

check('detectPageType：搜索页 / 笔记页 / 未知', () => {
  assert.equal(P.detectPageType({ location: { pathname: '/search_result' } }), 'search')
  assert.equal(P.detectPageType({ location: { pathname: '/explore/abc' } }), 'note')
  assert.equal(P.detectPageType({ location: { pathname: '/' } }), 'unknown')
})

check('parseSearchPage：从卡片 DOM 提取标题/作者/点赞/链接', () => {
  const card = el({ class: 'note-item' }, [
    el({ class: 'title' }, ['成都三天两夜攻略']),
    el({ class: 'author' }, [el({ class: 'name' }, ['小旅行家'])]),
    el({ class: 'count' }, ['2.3万']),
    el({ class: 'cover', href: '/explore/abc123' }, []),
  ])
  const doc = {
    location: { pathname: '/search_result', href: 'https://www.xiaohongshu.com/search_result?keyword=成都' },
    querySelector: (s) => (s.includes('note-item') ? card : null),
    querySelectorAll: (s) => (s.includes('note-item') ? [card] : []),
  }
  const items = P.parseSearchPage(doc)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '成都三天两夜攻略')
  assert.equal(items[0].author, '小旅行家')
  assert.equal(items[0].likes, 23000)
  assert.equal(items[0].link, 'https://www.xiaohongshu.com/explore/abc123')
})

check('parseNotePage：提取正文摘要与互动数', () => {
  const doc = {
    location: { pathname: '/explore/xyz789', href: 'https://www.xiaohongshu.com/explore/xyz789' },
    querySelector: (s) => {
      if (s.includes('detail-title')) return el({}, ['宽窄巷子避坑指南'])
      if (s.includes('detail-desc')) return el({}, ['早上八点前去，人少好拍照…'])
      if (s.includes('like-wrapper')) return el({}, [el({ class: 'count' }, ['999'])])
      return null
    },
  }
  const items = P.parseNotePage(doc)
  assert.equal(items[0].title, '宽窄巷子避坑指南')
  assert.equal(items[0].summary.includes('早上八点'), true)
  assert.equal(items[0].likes, 999)
  assert.equal(items[0].link, 'https://www.xiaohongshu.com/explore/xyz789')
})

check('stateFallback：从 __INITIAL_STATE__ 的 search.feeds 提取（DOM 无卡片时兜底）', () => {
  const state = {
    search: { feeds: [
      { id: 'feed001', note_card: {
        display_title: '状态里的笔记', user: { nickname: '状态作者' },
        interact_info: { liked_count: '3.2万', collected_count: '1200', comment_count: '88' },
        cover: { url_default: 'https://xhscdn.test/s.jpg' },
      } },
    ] },
  }
  const raw = 'window.__INITIAL_STATE__=' + JSON.stringify(state) + ';'
  const doc = {
    location: { pathname: '/search_result', href: 'https://www.xiaohongshu.com/search_result' },
    querySelectorAll: (s) => (s === 'script' ? [{ textContent: raw }] : []),
    querySelector: () => null,
  }
  const items = P.stateFallback(doc)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '状态里的笔记')
  assert.equal(items[0].author, '状态作者')
  assert.equal(items[0].likes, 32000)
  assert.equal(items[0].collects, 1200)
  assert.equal(items[0].link, 'https://www.xiaohongshu.com/explore/feed001')
})

check('stateFallback：__NEXT_DATA__ 不含 marker 时不误判（v1.1 修复）', () => {
  const doc = {
    querySelectorAll: () => [
      { textContent: '{"page":"no state here"}' }, // __NEXT_DATA__ 先出现
      { textContent: 'window.__INITIAL_STATE__={"note":{"a":1}};' },
    ],
  }
  const items = P.stateFallback(doc)
  assert.deepEqual(items, [])
})

check('detectLogin：识别已登录（用户头像入口）', () => {
  const doc = {
    querySelector: (s) => (s.includes('user-info') ? el({}, ['我']) : null),
    querySelectorAll: () => [],
  }
  assert.equal(P.detectLogin(doc), true)
})

check('detectLogin：识别未登录（登录按钮）', () => {
  const doc = {
    querySelector: () => null,
    querySelectorAll: (s) => (s === 'button' ? [el({}, ['登录'])] : []),
  }
  assert.equal(P.detectLogin(doc), false)
})

check('collect：导出包带登录凭证（未登录时 loggedIn=false）', () => {
  const doc = {
    location: { pathname: '/search_result', href: 'https://www.xiaohongshu.com/search_result' },
    querySelector: () => null,
    querySelectorAll: (s) => (s === 'button' ? [el({}, ['登录'])] : []),
  }
  const payload = P.collect(doc)
  assert.equal(payload.loginChecked, true)
  assert.equal(payload.loggedIn, false)
  assert.ok(payload.extensionVersion)
  assert.ok(payload.notice.includes('尚未登录'))
})

check('normalizeImage：只放行小红书图床 https，补齐协议相对地址', () => {
  assert.equal(P.normalizeImage('//sns-webpic-qc.xhscdn.com/a.jpg'), 'https://sns-webpic-qc.xhscdn.com/a.jpg')
  assert.equal(P.normalizeImage('https://sns-img-qc.xhscdn.com/b.jpg'), 'https://sns-img-qc.xhscdn.com/b.jpg')
  assert.equal(P.normalizeImage('http://sns-img-qc.xhscdn.com/c.jpg'), '')
  assert.equal(P.normalizeImage('https://evil.com/d.jpg'), '')
  assert.equal(P.normalizeImage('data:image/gif;base64,AAA'), '')
})

check('imageUrl：src 是占位图时改取 srcset / background-image（封面空白根因）', () => {
  const lazy = el({ src: 'data:image/gif;base64,AAA', srcset: 'https://sns-webpic-qc.xhscdn.com/x.jpg 1x, https://sns-webpic-qc.xhscdn.com/y.jpg 2x' })
  assert.equal(P.imageUrl(lazy), 'https://sns-webpic-qc.xhscdn.com/x.jpg')
  const bg = el({ style: "background-image: url('//sns-img-qc.xhscdn.com/bg.jpg')" })
  assert.equal(P.imageUrl(bg), 'https://sns-img-qc.xhscdn.com/bg.jpg')
  assert.equal(P.imageUrl(el({ src: 'https://evil.com/z.jpg' })), '')
})

check('parseSearchPage：卡片封面取 src/srcset，并过滤外站图', () => {
  const card = el({ class: 'note-item' }, [
    el({ class: 'title' }, ['带封面的笔记']),
    el({ class: 'cover', href: '/explore/cover1', src: '//sns-webpic-qc.xhscdn.com/cover1.jpg' }),
  ])
  const doc = {
    location: { pathname: '/search_result', href: 'https://www.xiaohongshu.com/search_result' },
    querySelector: (s) => (s.includes('note-item') ? card : null),
    querySelectorAll: (s) => (s.includes('note-item') ? [card] : []),
  }
  const items = P.parseSearchPage(doc)
  assert.equal(items[0].cover, 'https://sns-webpic-qc.xhscdn.com/cover1.jpg')
})

check('stateCover：cover 为对象/数组时取 url_default 或 info_list[0].url', () => {
  assert.equal(P.stateCover({ url_default: 'https://sns-webpic-qc.xhscdn.com/o.jpg' }), 'https://sns-webpic-qc.xhscdn.com/o.jpg')
  assert.equal(P.stateCover([{ url: 'https://sns-img-qc.xhscdn.com/arr.jpg' }]), 'https://sns-img-qc.xhscdn.com/arr.jpg')
  assert.equal(P.stateCover({ info_list: [{ url: 'https://sns-img-qc.xhscdn.com/info.jpg' }] }), 'https://sns-img-qc.xhscdn.com/info.jpg')
  assert.equal(P.stateCover({ url: 'https://evil.com/bad.jpg' }), '')
})

check('collect：DOM 缺封面时用 __INITIAL_STATE__ 同链接笔记补齐', () => {
  const card = el({ class: 'note-item' }, [
    el({ class: 'title' }, ['无封面卡片']),
    el({ class: 'cover', href: '/explore/m1' }),
  ])
  const state = { search: { feeds: [{ id: 'm1', note_card: { display_title: '无封面卡片', cover: { url_default: '//sns-webpic-qc.xhscdn.com/state.jpg' } } }] } }
  const raw = 'window.__INITIAL_STATE__=' + JSON.stringify(state) + ';'
  const doc = {
    location: { pathname: '/search_result', href: 'https://www.xiaohongshu.com/search_result' },
    querySelector: (s) => (s.includes('note-item') ? card : null),
    querySelectorAll: (s) => (s.includes('note-item') ? [card] : (s === 'script' ? [{ textContent: raw }] : [])),
  }
  const payload = P.collect(doc)
  assert.equal(payload.items[0].cover, 'https://sns-webpic-qc.xhscdn.com/state.jpg')
})

check('dedupe：按链接去重', () => {
  const out = P.dedupe([
    { title: 'a', link: 'https://www.xiaohongshu.com/explore/1' },
    { title: 'b', link: 'https://www.xiaohongshu.com/explore/1' },
    { title: 'c', link: 'https://www.xiaohongshu.com/explore/2' },
  ])
  assert.equal(out.length, 2)
})

console.log('\n通过 ' + passed + ' 项断言' + (process.exitCode ? '（存在失败）' : '，全部通过'))
