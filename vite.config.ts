import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'web',
  server: {
    port: 5173,
    // shared/ 位于 web/ 之外，允许 Vite 读取上级目录的共享类型
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8888',
        changeOrigin: true,
        // 后端未启动时 http-proxy 默认返回空 500，前端只能报「服务返回异常」；
        // 这里改成结构化 JSON，让注册页直接显示可执行的排查提示。
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            // SSE 客户端断开也会走到这里，此时响应可能已结束，写入需容错
            try {
              const response = res as unknown as {
                headersSent?: boolean
                writeHead?: (status: number, headers: Record<string, string>) => void
                end?: (body: string) => void
              }
              if (!response.headersSent && response.writeHead && response.end) {
                response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
                response.end(JSON.stringify({
                  ok: false,
                  error: '后端 API 未启动（8888 端口无响应）：请在项目目录执行 npm run dev，或单独执行 npm run dev:server',
                }))
              }
            } catch {
              // 连接已关闭，忽略
            }
          })
        },
      },
    },
  },
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
})
