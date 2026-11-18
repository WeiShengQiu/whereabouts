#!/usr/bin/env bash
# 旅游规划平台一键启动脚本
#
# 前端由 Vite 构建为静态资源，后端 Express 在 8888 端口同时托管页面与 /api 接口，
# 因此一条命令即可启动「前后端」，无需再单独跑 Vite。
#
# 用法：
#   ./start.sh                 前台启动（Ctrl+C 停止），启动前自动构建前端
#   ./start.sh --skip-build    跳过构建，直接用已有的 web-dist 启动
#   sudo systemctl start travel-planner    服务器上由 systemd 守护并开机自启
set -euo pipefail

cd "$(dirname "$0")"

# .env 是唯一配置源；外部环境优先，便于 systemd / 临时调试覆盖
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
PORT="${PORT:-8888}"
HOST="${HOST:-0.0.0.0}"
export PORT HOST NODE_ENV=production

# Node 22.21+ 的内置 fetch 通过该开关读取 .env 中的 HTTPS_PROXY / HTTP_PROXY。
# 仅当部署方自己提供了合规出网通道时才启用；未配置代理时行为完全不变。
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  export NODE_USE_ENV_PROXY=1
fi

# 本机笔记检索 sidecar 不应走外部代理；NO_PROXY 对代理客户端与 Node 内置 fetch 同时生效
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost"

log() { printf '[start] %s\n' "$*"; }

# 1. Node 版本检查
if ! command -v node >/dev/null 2>&1; then
  echo '[错误] 未找到 Node.js，请安装 Node 20 或更高版本'
  exit 1
fi
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]; then
  echo "[错误] Node 版本过低：$(node -v)，需要 20+"
  exit 1
fi

# 2. 首次部署自动生成 .env 并固定加密密钥；更换密钥会导致已保存的 API Key 无法解密
if [ ! -f .env ]; then
  KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  cat > .env <<EOF
PORT=8888
HOST=0.0.0.0
APP_ENCRYPTION_KEY=$KEY
COOKIE_SECURE=false
DEFAULT_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DEFAULT_LLM_API_KEY=
DEFAULT_LLM_MODEL=qwen-plus
DEFAULT_LLM_PROTOCOL=chat_completions
SESSION_TTL_DAYS=7
DATA_DIR=./data
EOF
  chmod 600 .env
  export APP_ENCRYPTION_KEY="$KEY"
  log '已生成 .env（含加密密钥，请勿提交 Git，也不要更换）'
fi

# 3. 依赖：首次运行自动安装
if [ ! -x node_modules/.bin/tsx ]; then
  log '首次运行，正在安装依赖...'
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

# 4. 前端构建
if [ "${1:-}" = '--skip-build' ]; then
  if [ ! -f web-dist/index.html ]; then
    echo '[错误] 缺少 web-dist/index.html，请先执行一次 ./start.sh'
    exit 1
  fi
  log '跳过前端构建'
else
  log '正在构建前端（tsc 类型检查 + Vite 打包）...'
  npm run build
fi

# 5. 端口占用检查，避免与 systemd 守护的实例重复启动
if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -Eq ":${PORT}[[:space:]]"; then
  echo "[错误] ${PORT} 端口已被占用。若服务由 systemd 守护，请执行：sudo systemctl restart travel-planner"
  exit 1
fi

mkdir -p "${DATA_DIR:-./data}"
log "服务地址：http://${HOST}:${PORT}   NODE_ENV=production  COOKIE_SECURE=${COOKIE_SECURE:-false}"
exec ./node_modules/.bin/tsx server/src/index.ts
