#!/usr/bin/env python3
"""部署接收端：鉴权后接收加密部署包，只执行固定流程，不提供任意命令入口。

配置来自 /etc/travel-planner-deploy.conf（chmod 600）：
  DEPLOY_TOKEN / DEPLOY_AES_KEY / DEPLOY_DIR / DEPLOY_SERVICE / DEPLOY_PORT
"""
import hashlib
import http.server as H
import json
import os
import socketserver as S
import subprocess as P
import tempfile
import threading
import time

C = {}
for line in open('/etc/travel-planner-deploy.conf', encoding='utf-8'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        C[k.strip()] = v.strip()

TOKEN = C['DEPLOY_TOKEN']
KEY = C['DEPLOY_AES_KEY']
DIR = C.get('DEPLOY_DIR', '/opt/travel-planner')
SERVICE = C.get('DEPLOY_SERVICE', 'travel-planner')
PORT = int(C.get('DEPLOY_PORT', '8899'))
LOCK = threading.Lock()


def run(cmd, timeout=300):
    p = P.run(cmd, shell=True, cwd=DIR, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()[-2000:]


def lock_hash():
    f = os.path.join(DIR, 'package-lock.json')
    return hashlib.sha256(open(f, 'rb').read()).hexdigest() if os.path.exists(f) else ''


def deploy(enc):
    with tempfile.TemporaryDirectory() as t:
        tgz = os.path.join(t, 'src.tgz')
        rc, out = run(f"openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:'{KEY}' -in '{enc}' -out '{tgz}'", 60)
        if rc:
            return False, '解密失败：' + out
        old = lock_hash()
        rc, out = run(f"tar xzf '{tgz}' -C '{DIR}'", 60)
        if rc:
            return False, '解压失败：' + out
        # macOS tar 会带入 AppleDouble 扩展属性文件，Linux 侧清理掉
        run("find . -name '._*' -delete && chmod +x start.sh && chown -R root:root server shared web start.sh", 60)
        if old != lock_hash():
            rc, out = run('npm ci --no-audit --no-fund', 300)
            if rc:
                return False, '依赖安装失败：' + out
        rc, out = run('npm run build', 300)
        if rc:
            return False, '构建失败（服务仍在运行旧版本，修复后请重新发布）：' + out
        rc, out = run(f'systemctl restart {SERVICE}', 60)
        if rc:
            return False, '重启失败：' + out
        for _ in range(60):
            if run('curl -fsS --max-time 2 http://127.0.0.1:8888/api/health', 10)[0] == 0:
                return True, '部署完成，服务已就绪'
            time.sleep(1)
        return False, '健康检查未通过，请查看 journalctl -u ' + SERVICE


class Handler(H.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, {'ok': self.path == '/health'})

    def do_POST(self):
        if self.path != '/' + TOKEN:
            self.reply(403, {'ok': False, 'error': 'forbidden'})
            return
        if not LOCK.acquire(blocking=False):
            self.reply(409, {'ok': False, 'error': '另有部署正在进行'})
            return
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if not 0 < n <= 20 * 1024 * 1024:
                self.reply(400, {'ok': False, 'error': '包大小异常'})
                return
            fd, enc = tempfile.mkstemp(suffix='.enc')
            with os.fdopen(fd, 'wb') as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                os.unlink(enc)
                self.reply(400, {'ok': False, 'error': '传输不完整'})
                return
            ok, msg = deploy(enc)
            os.unlink(enc)
            self.reply(200 if ok else 500, {'ok': ok, 'message': msg})
        except Exception as e:
            self.reply(500, {'ok': False, 'error': str(e)[:400]})
        finally:
            LOCK.release()


class Server(S.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('0.0.0.0', PORT), Handler) as srv:
    srv.serve_forever()
