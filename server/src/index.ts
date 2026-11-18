import 'dotenv/config'
import express, { type ErrorRequestHandler } from 'express'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRouter } from './auth'
import { configsRouter } from './configs'
import { evidenceRouter } from './evidence-routes'
import { xhsResearchRouter } from './xhs-research-routes'
import { plansRouter } from './plans'

// Node 22.21+ 的内置 fetch 通过该开关读取 HTTPS_PROXY / HTTP_PROXY。
// start.sh 会在进程启动前导出；此处作为 npm run dev:server 直启时的补充。
if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY)) {
  process.env.NODE_USE_ENV_PROXY = '1'
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, data: { service: 'travel-planner', time: new Date().toISOString() } })
})
app.use('/api/auth', authRouter)
app.use('/api/configs', configsRouter)
app.use('/api', evidenceRouter)
app.use('/api', xhsResearchRouter)
app.use('/api', plansRouter)
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' })
})

// 生产构建产物由同一端口托管；开发模式下由 Vite 在 5173 提供页面并代理 /api
const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../../web-dist')
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[error]', err instanceof Error ? err.message : err)
  const message = err instanceof Error ? err.message : '服务内部错误'
  res.status(500).json({ ok: false, error: message.slice(0, 400) })
}
app.use(errorHandler)

const port = Number(process.env.PORT ?? 8888)
const host = process.env.HOST ?? '127.0.0.1'
app.listen(port, host, () => {
  console.log(`[travel-planner] API 已启动: http://${host}:${port}`)
  if (host === '127.0.0.1') {
    console.log('[travel-planner] 仅监听本机；需要公网访问时设置 HOST=0.0.0.0 并在前面挂 Nginx + HTTPS')
  }
})
