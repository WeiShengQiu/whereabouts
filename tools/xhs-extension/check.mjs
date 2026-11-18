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

// 4. 所有 JS 语法正确
for (const f of ['parser.js', 'content.js', 'popup.js', 'background.js']) {
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
} catch (e) {
  ok('popup.js / manifest 可读', false, e.message)
}

console.log('\n' + (failed ? `自检未通过：${failed} 项` : '自检全部通过，可在浏览器加载 tools/xhs-extension/ 目录'))
process.exit(failed ? 1 : 0)
