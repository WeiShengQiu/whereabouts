#!/usr/bin/env bash
# 启动小红书笔记检索 sidecar。配置从主目录读取，不放在项目内，避免 Cookie 被打包或提交。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${XHS_CONFIG_FILE:-$HOME/.travel-planner-xhs.env}"
VENV_DIR="${XHS_VENV_DIR:-$HOME/.cache/travel-planner-xhs-venv}"

[ -f "$CONFIG_FILE" ] || { printf '缺少配置：%s（先复制 xhs.env.example 并填写）\n' "$CONFIG_FILE" >&2; exit 1; }
[ -x "$VENV_DIR/bin/python" ] || { printf '缺少虚拟环境：%s（先运行 ./bootstrap.sh）\n' "$VENV_DIR" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

: "${XHS_SIDECAR_TOKEN:?配置缺少 XHS_SIDECAR_TOKEN}"
: "${XHS_COOKIE:?配置缺少 XHS_COOKIE}"
export XHS_SPIDER_DIR="${XHS_SPIDER_DIR:-$HOME/.cache/spider-xhs}"

exec "$VENV_DIR/bin/python" "$HERE/xhs_sidecar.py"
