#!/usr/bin/env bash
# 安装「小红书笔记检索 sidecar」的运行依赖。上游代码与虚拟环境都放在项目之外，
# 不会随 deploy.sh 发布，也不会被打包进 Git 仓库。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SPIDER_DIR="${XHS_SPIDER_DIR:-$HOME/.cache/spider-xhs}"
VENV_DIR="${XHS_VENV_DIR:-$HOME/.cache/travel-planner-xhs-venv}"
CONFIG_FILE="${XHS_CONFIG_FILE:-$HOME/.travel-planner-xhs.env}"

log() { printf '[xhs-bootstrap] %s\n' "$*"; }
die() { printf '[xhs-bootstrap] 失败：%s\n' "$*" >&2; exit 1; }

PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "缺少 python3"
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
  || die "Spider_XHS 需要 Python 3.10+，当前为 $("$PYTHON_BIN" -V 2>&1)"
command -v node >/dev/null 2>&1 || die "缺少 Node.js（签名计算用到 crypto-js，需 Node 20+）"
command -v npm >/dev/null 2>&1 || die "缺少 npm"
command -v git >/dev/null 2>&1 || die "缺少 git"

if [ -d "$SPIDER_DIR/.git" ]; then
  log "上游已存在：$SPIDER_DIR（不自动更新，避免签名算法变更破坏现有配置）"
else
  log "克隆 Spider_XHS 到 $SPIDER_DIR ..."
  mkdir -p "$(dirname "$SPIDER_DIR")"
  git clone --depth 1 https://github.com/cv-cat/Spider_XHS.git "$SPIDER_DIR" || die "克隆失败"
fi

log "安装上游 Node 依赖（crypto-js）..."
(cd "$SPIDER_DIR" && npm install --silent) || die "npm install 失败"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  log "创建虚拟环境 $VENV_DIR ..."
  "$PYTHON_BIN" -m venv "$VENV_DIR" || die "创建虚拟环境失败"
fi

log "安装 Python 依赖（首次可能需要几分钟）..."
"$VENV_DIR/bin/pip" install -q --upgrade pip
"$VENV_DIR/bin/pip" install -r "$SPIDER_DIR/requirements.txt" || die "pip install 失败；Python 3.13 可能与 PyExecJS / curl_cffi 不兼容，建议改用 Python 3.11 或 3.12 后设置 PYTHON_BIN 重试"

log "依赖自检（占位配置，不发任何外部请求）..."
XHS_SPIDER_DIR="$SPIDER_DIR" XHS_COOKIE='dependency-check-only' XHS_SIDECAR_TOKEN='dependency-check-only' \
  "$VENV_DIR/bin/python" "$HERE/xhs_sidecar.py" --check \
  || die "依赖自检失败：常见原因是 Node 未安装或 Python 版本与上游依赖不兼容"

cat <<EOF

[xhs-bootstrap] 依赖安装完成。
  上游代码：  $SPIDER_DIR
  虚拟环境：  $VENV_DIR

下一步（Cookie 只保存在主目录，绝不写进项目或提交到 Git）：
  cp "$HERE/xhs.env.example" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  # 编辑 $CONFIG_FILE，填入 XHS_COOKIE（你本人账号的完整 Cookie）与 XHS_SIDECAR_TOKEN
  "$VENV_DIR/bin/python" "$HERE/xhs_sidecar.py" --check
  "$HERE/start.sh"

主服务侧另需在 .env 配置 XHS_NOTES_ENABLED=1、XHS_NOTES_URL、XHS_NOTES_TOKEN 后重启。
EOF
