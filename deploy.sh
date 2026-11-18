#!/usr/bin/env bash
# 一键发布：本地改完代码后执行 ./deploy.sh，自动同步到服务器、构建、重启并做健康检查。
#
# 通道：本地打包 → AES-256 加密 → POST 到服务器部署接收端（8899）
#       接收端校验 token、解密、按需装依赖、构建、重启服务、自检后才返回结果。
#
# 凭据文件 ~/.travel-planner-deploy.env（chmod 600，不入库）：
#   DEPLOY_ENDPOINT=http://<服务器IP>:8899
#   DEPLOY_TOKEN=<48 位随机 hex>
#   DEPLOY_AES_KEY=<64 位随机 hex>
#   APP_URL=http://<服务器IP>:8888
#
# 安全边界：.env（加密密钥、大模型 API Key）与 data/（用户数据）永不同步；
# 只覆盖源码文件，不删除服务器上任何既有文件。
set -euo pipefail

cd "$(dirname "$0")"

CRED_FILE="${DEPLOY_CRED_FILE:-$HOME/.travel-planner-deploy.env}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] 失败：%s\n' "$*" >&2; exit 1; }

[ -f "$CRED_FILE" ] || die "找不到部署凭据：${CRED_FILE}（首次配置见 README）"
set -a
# shellcheck disable=SC1090
. "$CRED_FILE"
set +a
: "${DEPLOY_ENDPOINT:?凭据缺少 DEPLOY_ENDPOINT}" \
  "${DEPLOY_TOKEN:?凭据缺少 DEPLOY_TOKEN}" \
  "${DEPLOY_AES_KEY:?凭据缺少 DEPLOY_AES_KEY}" \
  "${APP_URL:?凭据缺少 APP_URL}"

for bin in tar curl openssl npm; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少命令：${bin}"
done

log "目标 ${DEPLOY_ENDPOINT} → ${APP_URL}"

# 1. 本地预检：类型检查 + 前端构建，把错误挡在发布之前
log '本地类型检查与构建...'
npm run build >/dev/null || die '本地构建失败，已中止发布（服务器未改动）'

# 2. 接收端可达性
curl --noproxy '*' -fsS --max-time 10 "${DEPLOY_ENDPOINT}/health" >/dev/null \
  || die '部署接收端不可达：检查云防火墙 8899 与 systemctl status travel-planner-deploy'

TGZ="$(mktemp -t tp-src)" || die '无法创建临时文件'
ENC="$(mktemp -t tp-enc)" || die '无法创建临时文件'
trap 'rm -f "$TGZ" "$ENC"' EXIT

# 3. 打包 + 加密；排除密钥、数据、依赖、构建产物
# 额外排除任意子目录的 .env 与 sidecar 依赖：小红书 Cookie 只允许存在用户主目录，
# 绝不能被加密包带到服务器。
log '打包并加密源码（排除 .env / data / node_modules / web-dist）...'
# macOS tar 会为带扩展属性的文件额外写入 ._* 伴生成员；关掉后服务器侧无需再清理
COPYFILE_DISABLE=1 tar czf "$TGZ" \
  --exclude='./node_modules' --exclude='./data' --exclude='./web-dist' \
  --exclude='./.env' --exclude='*/.env' --exclude='./.git' --exclude='./.DS_Store' \
  --exclude='./tools/xhs-notes/.venv' --exclude='./tools/xhs-notes/vendor' \
  --exclude='*/__pycache__' --exclude='*/node_modules' \
  --exclude='._*' --exclude='*/._*' \
  --exclude='./.deploy-lock-hash' --exclude='*.log' . \
  || die '打包失败'
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass "pass:${DEPLOY_AES_KEY}" -in "$TGZ" -out "$ENC" \
  || die '加密失败'
log "密文 $(wc -c < "$ENC" | tr -d ' ') 字节"

# 4. 推送；接收端完成构建与重启后才返回
log '推送并等待服务器构建、重启...'
RESP="$(curl --noproxy '*' -sS --max-time 300 -X POST \
  -H 'Expect:' -H 'Content-Type: application/octet-stream' \
  --data-binary @"$ENC" "${DEPLOY_ENDPOINT}/${DEPLOY_TOKEN}")" \
  || die '推送失败（网络中断或接收端超时）'
printf '[server] %s\n' "$RESP"
printf '%s' "$RESP" | grep -q '"ok": *true' \
  || die '服务器部署失败，详见上方返回；可查看 journalctl -u travel-planner -n 50'

# 5. 公网侧复核
log '公网健康检查...'
curl --noproxy '*' -fsS --max-time 10 "${APP_URL}/api/health" >/dev/null \
  || die '服务本机已就绪但公网检查失败，请检查云防火墙 8888 规则'

log "发布完成：${APP_URL}"
