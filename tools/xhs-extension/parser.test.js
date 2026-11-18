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

check('dedupe：按链接去重', () => {
  const out = P.dedupe([
    { title: 'a', link: 'https://www.xiaohongshu.com/explore/1' },
    { title: 'b', link: 'https://www.xiaohongshu.com/explore/1' },
    { title: 'c', link: 'https://www.xiaohongshu.com/explore/2' },
  ])
  assert.equal(out.length, 2)
})

console.log('\n通过 ' + passed + ' 项断言' + (process.exitCode ? '（存在失败）' : '，全部通过'))
