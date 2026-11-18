#!/usr/bin/env python3
# encoding: utf-8
"""小红书笔记检索 sidecar（独立研究通道，默认不启用）。

职责边界：
- 只暴露 /health 与 /search，只调用 Spider_XHS 的 search_some_note() 做关键词检索；
- 只回传笔记标题、作者、互动数、类型与回源链接，不取正文、评论、图片、视频，不落盘；
- 仅监听 127.0.0.1，必须带 token，全局串行且最小调用间隔，避免高频请求；
- 上游风控（403/429/验证码）原样标记为 RISK_CONTROL，由主服务熔断降级，绝不伪造数据。

上游项目 https://github.com/cv-cat/Spider_XHS 自述「仅供学习交流使用，禁止任何商业化行为」
且未提供 LICENSE。本脚本不复制其任何代码，只在运行时按需 import；是否启用、是否合规
由部署者自行判断并承担全部责任。生产环境请优先使用平台官方授权接口。
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("XHS_SIDECAR_PORT", "8901"))
TOKEN = os.environ.get("XHS_SIDECAR_TOKEN", "")
SPIDER_DIR = Path(os.environ.get("XHS_SPIDER_DIR", "")).expanduser()
COOKIE = os.environ.get("XHS_COOKIE", "").strip()
MIN_INTERVAL = max(0.0, float(os.environ.get("XHS_SIDECAR_MIN_INTERVAL", "3")))
MAX_LIMIT = max(1, min(20, int(os.environ.get("XHS_SIDECAR_MAX_LIMIT", "20"))))

SORT_CHOICES = {"general": 0, "latest": 1, "popular": 2, "comments": 3, "collects": 4}

_lock = threading.Lock()
_last_call = 0.0
_api = None
_api_error = ""


def _import_upstream() -> str:
    """把 Spider_XHS 加入 sys.path 并验证可导入；返回空字符串表示成功。"""
    if not SPIDER_DIR or not SPIDER_DIR.is_dir():
        return f"未找到 Spider_XHS 目录：{SPIDER_DIR or '(未设置 XHS_SPIDER_DIR)'}，请先运行 ./bootstrap.sh"
    sys.path.insert(0, str(SPIDER_DIR))
    try:
        global _api_mod, _auth_mod
        from apis.xhs_pc_apis import XHS_Apis as _api_mod  # noqa: PLC0415
        from xhs_utils.xhs_pc import XHSPcAuth as _auth_mod  # noqa: PLC0415
    except Exception as error:  # 依赖缺失、Node 未安装、Python 版本不兼容都在这里明确报出
        return f"Spider_XHS 导入失败：{type(error).__name__}: {error}"
    return ""


_upstream_error = _import_upstream()


def _config_error() -> str:
    if not TOKEN:
        return "未设置 XHS_SIDECAR_TOKEN，拒绝以无鉴权方式启动"
    if not COOKIE:
        return "未设置 XHS_COOKIE（需使用你本人账号的完整 Cookie）"
    return _upstream_error


def _get_api():
    """首次检索时才建立登录态并 bootstrap，/health 不触发任何外部请求。"""
    global _api, _api_error
    if _api is not None:
        return _api, ""
    if _api_error:
        return None, _api_error
    try:
        auth = _auth_mod.from_cookie(COOKIE)
        api = _api_mod(auth)
        api.bootstrap()
        _api = api
        return _api, ""
    except Exception as error:
        _api_error = f"登录态初始化失败：{type(error).__name__}: {error}"
        return None, _api_error


def _text(value, limit: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _count(value) -> int | None:
    """互动数可能是 '1.2万' / '1,234' / int，统一成非负整数。"""
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace(",", "")
    try:
        if raw.endswith("万"):
            return int(float(raw[:-1]) * 10_000)
        if raw.endswith("千"):
            return int(float(raw[:-1]) * 1_000)
        return int(float(raw))
    except ValueError:
        return None


def _normalize(items: list, limit: int) -> list[dict]:
    """从上游 data.items 提取最小字段集；任何异常字段都跳过而不是猜测。"""
    notes = []
    for item in items:
        if not isinstance(item, dict) or item.get("model_type") != "note":
            continue
        note_id = _text(item.get("id"), 64)
        if not note_id:
            continue
        card = item.get("note_card") if isinstance(item.get("note_card"), dict) else {}
        user = card.get("user") if isinstance(card.get("user"), dict) else {}
        interact = card.get("interact_info") if isinstance(card.get("interact_info"), dict) else {}
        token = _text(item.get("xsec_token"), 256)
        url = f"https://www.xiaohongshu.com/explore/{urllib.parse.quote(note_id)}"
        if token:
            url += f"?xsec_token={urllib.parse.quote(token)}&xsec_source=pc_search"
        notes.append({
            "id": note_id,
            "title": _text(card.get("display_title") or card.get("title")),
            "author": _text(user.get("nickname") or user.get("nick_name")),
            "likes": _count(interact.get("liked_count")),
            "collects": _count(interact.get("collected_count")),
            "comments": _count(interact.get("comment_count")),
            "noteType": _text(card.get("type"), 20),
            "url": url,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        if len(notes) >= limit:
            break
    return notes


def do_search(keyword: str, limit: int, sort_key: str) -> tuple[int, dict]:
    error = _config_error()
    if error:
        return 503, {"ok": False, "error": "NOT_READY", "message": error}

    api, error = _get_api()
    if error:
        return 502, {"ok": False, "error": "UPSTREAM_INIT", "message": error}

    # 全局串行 + 最小间隔：即使多个用户并发查询，也不会对平台形成突发流量
    global _last_call
    with _lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        try:
            success, message, items = api.search_some_note(keyword, limit, SORT_CHOICES[sort_key])
        except Exception as upstream:  # 上游异常可能含风控信息，统一按文本识别
            success, items = False, []
            message = f"{type(upstream).__name__}: {upstream}"
        finally:
            _last_call = time.monotonic()

    text = str(message)
    if not success or any(flag in text for flag in ("403", "429", "验证码", "captcha", "risk", "登录已失效")):
        return 429, {
            "ok": False,
            "error": "RISK_CONTROL",
            "message": "上游返回风控、限流或登录态失效，本次不重试、不换身份，请降低频率或更新 Cookie",
            "detail": text[:200],
        }
    if not isinstance(items, list):
        return 502, {"ok": False, "error": "BAD_UPSTREAM", "message": "上游返回结构异常"}
    notes = _normalize(items, limit)
    return 200, {"ok": True, "data": {"query": keyword, "count": len(notes), "items": notes}}


class Handler(BaseHTTPRequestHandler):
    server_version = "XhsNotesSidecar/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # 只记录方法与路径，不记录 Cookie、token、标题与上游响应内容
        sys.stderr.write("[sidecar] %s\n" % (fmt % args))

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-Sidecar-Token", "")
        return bool(TOKEN) and hmac.compare_digest(supplied, TOKEN)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            error = _config_error()
            self._send(200, {
                "ok": not error,
                "ready": not error,
                "reason": error or "已就绪（未发起任何外部请求）",
                "spiderDir": str(SPIDER_DIR),
                "minInterval": MIN_INTERVAL,
                "maxLimit": MAX_LIMIT,
            })
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "UNAUTHORIZED", "message": "token 无效"})
            return
        if parsed.path != "/search":
            self._send(404, {"ok": False, "error": "NOT_FOUND", "message": "仅提供 /health 与 /search"})
            return
        params = urllib.parse.parse_qs(parsed.query)
        keyword = (params.get("keyword", [""])[0]).strip()[:60]
        if len(keyword) < 2:
            self._send(400, {"ok": False, "error": "BAD_KEYWORD", "message": "关键词至少 2 个字符"})
            return
        try:
            limit = max(1, min(MAX_LIMIT, int(params.get("limit", ["8"])[0])))
        except ValueError:
            limit = 8
        sort_key = params.get("sort", ["general"])[0]
        if sort_key not in SORT_CHOICES:
            sort_key = "general"
        started = time.monotonic()
        status, payload = do_search(keyword, limit, sort_key)
        self.log_message("search status=%s count=%s %.1fs", status, payload.get("data", {}).get("count", 0), time.monotonic() - started)
        self._send(status, payload)


def main() -> None:
    if "--check" in sys.argv:
        error = _config_error()
        print(json.dumps({
            "ok": not error,
            "python": sys.version.split()[0],
            "spiderDir": str(SPIDER_DIR),
            "hasCookie": bool(COOKIE),
            "hasToken": bool(TOKEN),
            "reason": error or "配置与依赖检查通过（未发起外部请求）",
        }, ensure_ascii=False, indent=2))
        raise SystemExit(0 if not error else 1)
    if not TOKEN:
        print("拒绝启动：未设置 XHS_SIDECAR_TOKEN", file=sys.stderr)
        raise SystemExit(2)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[sidecar] 监听 {HOST}:{PORT}；状态 {_config_error() or '已就绪'}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
