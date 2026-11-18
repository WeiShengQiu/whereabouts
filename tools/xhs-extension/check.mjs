/**
 * 行迹 · 小红书线索采集 —— 扩展加载前自检
 * 纯 Node 标准库，无第三方依赖。校验：manifest 合法、引用文件齐全、JS 语法正确、
 * parser.js 确实在注入列表（这正是 v1.0 的致命 bug）、popup 走主动注入路径。
 * 用法：node tools/xhs-extension/check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf-8')
const exists = (f) => fs.existsSync(path.join(dir, f))

let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + name)
  else { console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++ }
}

console.log('扩展加载前自检：')

// 1. manifest 合法
let manifest = null
try {
  manifest = JSON.parse(read('manifest.json'))
  ok('manifest.json 是合法 JSON', true)
} catch (e) {
  ok('manifest.json 是合法 JSON', false, e.message)
  console.error('\n自检未通过：' + failed + ' 项')
  process.exit(1)
}

ok('Manifest V3', manifest.manifest_version === 3)
ok('扩展版本 1.4.0（postMessage 握手 + 自动采集 + 封面兜底）', manifest.version === '1.4.0', manifest.version)
ok('manifest 含 action.popup', !!(manifest.action && manifest.action.default_popup))
ok('host_permissions 仅小红书域名',
  Array.isArray(manifest.host_permissions) &&
  manifest.host_permissions.length === 1 &&
  manifest.host_permissions[0] === 'https://www.xiaohongshu.com/*',
  JSON.stringify(manifest.host_permissions))

// 2. 关键 bug 防回归：parser.js 必须在注入列表
const cs = (manifest.content_scripts || [])[0]
ok('存在 content_scripts 配置', !!cs)
if (cs) {
  ok('content_scripts 注入 parser.js（v1.0 致命 bug 防回归）',
    Array.isArray(cs.js) && cs.js.includes('parser.js'), JSON.stringify(cs.js))
  ok('content_scripts 注入 content.js', Array.isArray(cs.js) && cs.js.includes('content.js'))
  ok('matches 仅小红书域名',
    Array.isArray(cs.matches) && cs.matches.every((m) => m.includes('xiaohongshu.com')),
    JSON.stringify(cs.matches))
}

// 3. manifest 引用的文件全部存在
const refs = [
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
].filter(Boolean)
for (const ref of refs) ok('引用文件存在：' + ref, exists(ref))

// 3b. 平台页注入块（供平台检测「扩展已安装」）
const bridgeBlock = (manifest.content_scripts || []).find((c) => (c.js || []).includes('bridge.js'))
ok('存在平台页注入块(bridge.js，供安装检测)', !!bridgeBlock)
if (bridgeBlock) {
  ok('平台注入块含 localhost/线上 IP 匹配',
    bridgeBlock.matches.some((m) => m.includes('localhost')) &&
    bridgeBlock.matches.some((m) => m.includes('150.158.179.138')),
    JSON.stringify(bridgeBlock.matches))
}
ok('已声明 storage 权限(共享登录态)',
  Array.isArray(manifest.permissions) && manifest.permissions.includes('storage'))

// 4. 所有 JS 语法正确
for (const f of ['parser.js', 'content.js', 'popup.js', 'background.js', 'bridge.js']) {
  if (!exists(f)) continue
  try {
    execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' })
    ok('语法正确：' + f, true)
  } catch (e) {
    ok('语法正确：' + f, false, String(e.stderr || e.message).split('\n')[0])
  }
}

// 5. popup 走主动注入路径
try {
  const pj = read('popup.js')
  ok('popup 用 scripting.executeScript 主动注入（免"接收端不存在"）',
    pj.includes('chrome.scripting.executeScript') && pj.includes('parser.js'))
  const mj = read('manifest.json')
  ok('已声明 scripting + tabs 权限',
    mj.includes('"scripting"') && mj.includes('"tabs"'))
  // 登录门禁：未登录不允许采集/导出
  ok('popup 采集后强制校验登录态',
    pj.includes('loggedIn') && pj.includes('loginChecked') && pj.includes('chrome.storage.local.set'))
} catch (e) {
  ok('popup.js / manifest 可读', false, e.message)
}

// 6. 解析器登录检测与导出凭证
try {
  const pj = read('parser.js')
  ok('parser 提供 detectLogin（只读 DOM 判断登录）', pj.includes('function detectLogin'))
  ok('导出包带登录凭证 loginChecked/loggedIn',
    pj.includes('loginChecked:') && pj.includes('loggedIn:'))
} catch (e) {
  ok('parser.js 可读', false, e.message)
}
try {
  const bj = read('bridge.js')
  ok('bridge 暴露 window.__XHS_COLLECTOR__ 安装标记', bj.includes('__XHS_COLLECTOR__'))
  // v1.2 致命 bug：content script 在 isolated world 写 window 属性，页面 JS 读不到。
  // v1.3 必须用 postMessage 握手，否则「装了扩展仍提示未安装」。
  ok('bridge 用 postMessage 跨隔离世界握手',
    bj.includes('window.postMessage') && bj.includes("addEventListener('message'"))
  ok('bridge 支持 PING / CHECK_LOGIN / COLLECT_ONE',
    bj.includes("type === 'PING'") && bj.includes("type !== 'CHECK_LOGIN' && type !== 'COLLECT_ONE'"))
} catch (e) {
  ok('bridge.js 可读', false, e.message)
}

// 7. 后台自动采集链路（v1.3）
try {
  const gj = read('background.js')
  ok('background 处理 CHECK_LOGIN / COLLECT_ONE',
    gj.includes('XHS_CHECK_LOGIN') && gj.includes('XHS_COLLECT_ONE'))
  ok('background 用非活动标签页 + 只读解析器采集',
    gj.includes('chrome.tabs.create') && gj.includes('active: false') && gj.includes('parser.js'))
  ok('background 同步登录态给平台检查项', gj.includes('xhsLastLoginState'))
  ok('background 有 busy 锁防止并发采集', gj.includes('busy = true') && gj.includes('busy = false'))
} catch (e) {
  ok('background.js 可读', false, e.message)
}

console.log('\n' + (failed ? `自检未通过：${failed} 项` : '自检全部通过，可在浏览器加载 tools/xhs-extension/ 目录'))
process.exit(failed ? 1 : 0)
