/**
 * bridge.js 协议级测试：模拟「页面 main world ↔ 扩展 isolated world」两个上下文。
 *
 * 专治 v1.2 的根因：内容脚本写 window.__XHS_COLLECTOR__ 页面读不到。
 * 本测试验证 v1.3 的 postMessage 握手在装了扩展后确实会把 STATUS 送给页面，
 * 且 PING / CHECK_LOGIN / COLLECT_ONE 都能拿到对应回包。
 *
 * 用法：node tools/xhs-extension/bridge.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(dir, 'bridge.js'), 'utf-8')

let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + name)
  else { console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++ }
}

// ---- 模拟 isolated world 的 window / chrome ----
const listeners = new Set()
const posted = []
const sentToBackground = []
const storageChanges = []
let storageState = {}

const fakeWindow = {
  postMessage(data) {
    posted.push(data)
    // 真实浏览器里 postMessage 是异步投递给同页面的所有监听者（含 isolated world）
    queueMicrotask(() => {
      for (const fn of Array.from(listeners)) fn({ source: fakeWindow, data })
    })
  },
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn) },
  removeEventListener(type, fn) { listeners.delete(fn) },
}

const fakeChrome = {
  storage: {
    local: { get: (_keys, cb) => cb(storageState), set: () => {} },
    onChanged: { addListener: (fn) => storageChanges.push(fn) },
  },
  runtime: {
    sendMessage(message, cb) {
      sentToBackground.push(message)
      if (message.type === 'XHS_CHECK_LOGIN') cb({ ok: true, loggedIn: true, loginChecked: true })
      else cb({
        ok: true,
        data: { loginChecked: true, loggedIn: true, count: 1, items: [{ title: '测试笔记', link: 'https://www.xiaohongshu.com/explore/abc' }] },
      })
    },
  },
}

const context = vm.createContext({ window: fakeWindow, chrome: fakeChrome, console, setTimeout, clearTimeout })
vm.runInContext(code, context, { filename: 'bridge.js' })

/** 模拟页面发一条请求，等待微任务队列投递后取回包 */
async function ask(data) {
  fakeWindow.postMessage({ __xhsBridge: 'req', ...data })
  await new Promise((resolve) => setTimeout(resolve, 0))
  // STATUS 是主动广播、没有 requestId；带 requestId 的回包才做精确匹配
  return posted.filter((p) => p.__xhsBridge === 'res' && (!p.requestId || p.requestId === data.requestId))
}

console.log('bridge 协议测试（跨隔离世界）：')

ok('加载后主动向页面广播 STATUS', posted.some((p) => p.type === 'STATUS' && p.installed === true), JSON.stringify(posted))
ok('STATUS 带版本号', posted.some((p) => p.type === 'STATUS' && p.version === '1.3.0'))

const afterPing = await ask({ type: 'PING', requestId: 'p1' })
ok('PING 能收到页面可见的 STATUS 回包', afterPing.some((p) => p.type === 'STATUS'), JSON.stringify(afterPing))

const afterLogin = await ask({ type: 'CHECK_LOGIN', requestId: 'l1' })
ok('CHECK_LOGIN 转发给后台并返回结果',
  sentToBackground.some((m) => m.type === 'XHS_CHECK_LOGIN') &&
  afterLogin.some((p) => p.type === 'CHECK_LOGIN_RESULT' && p.ok === true && p.loggedIn === true),
  JSON.stringify(afterLogin))

const afterCollect = await ask({ type: 'COLLECT_ONE', requestId: 'c1', keyword: '成都 火锅', category: 'food' })
ok('COLLECT_ONE 把关键词透传给后台',
  sentToBackground.some((m) => m.type === 'XHS_COLLECT_ONE' && m.keyword === '成都 火锅' && m.category === 'food'))
ok('COLLECT_ONE 回包带采集数据与 requestId',
  afterCollect.some((p) => p.type === 'COLLECT_ONE_RESULT' && p.requestId === 'c1' && p.ok === true && p.data.items.length === 1))

// 另一个标签页采集后，后台写 storage → 平台页检查项应实时更新
for (const fn of storageChanges) fn({ xhsLastLoginState: { newValue: true }, xhsLastCheckedAt: { newValue: '2026-11-18T00:00:00.000Z' } }, 'local')
await new Promise((resolve) => setTimeout(resolve, 0))
ok('登录态变更会主动广播 STATUS', posted.some((p) => p.type === 'STATUS' && p.lastLoginState === true))

console.log('\n' + (failed ? `协议测试未通过：${failed} 项` : '协议测试全部通过：页面能可靠检测到扩展并完成自动采集握手'))
process.exit(failed ? 1 : 0)
