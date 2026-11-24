"""云端模拟器截图、自检用的假"讲解版服务"。只在 GitHub Actions 的 Mac 上跑，不是给平时用的。

静态文件从 ci/fixture/ 读（一道 2009 年的示例题 + kit/ + vendor/，从 board2 抄来的）。
另外假装几个接口：/draft（存在内存里）、/status、/feedback、/records、/reports、/ask/history，
/ask/stream 发两条 SSE 消息（自检里看 b2:// 能不能把流式回答转过去），其余 POST 一律回 {"ok": true}。
用法：python3 ci/stub_server.py <端口> <fixture 目录>
"""
import http.server
import json
import os
import socketserver
import sys
import time
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8409
ROOT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "fixture"))
# 2009-01 预先放一份旧格式（v2）草稿：两条横线，测"清空时垫底的旧笔迹一起清、撤销能恢复"
SEED_DRAFTS = {"2009-01": {"v": 2, "t": 1, "view": None, "pages": [], "s": [
    {"c": "blue", "w": 2.6, "e": 0, "k": 1, "o": [60, 520], "p": [0, 0, 0.5, 120, 4, 0.5, 240, 0, 0.5]},
    {"c": "blue", "w": 2.6, "e": 0, "k": 1, "o": [60, 560], "p": [0, 0, 0.5, 120, 4, 0.5, 240, 0, 0.5]}]}}
DRAFTS = json.loads(json.dumps(SEED_DRAFTS))
POSTS = []
STATE = {"offline": False}   # /_offline 以后：除了 /_ 开头的控制接口，一律不回话直接断开（App 那边当"连不上电脑"）


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def parse_request(self):
        ok = super().parse_request()
        if ok and STATE["offline"] and not self.path.startswith("/_"):
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return False
        return ok

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 带时刻（UTC，毫秒），和 App 日志的时间对得上
        t = time.time()
        sys.stderr.write("[stub] " + time.strftime("%H:%M:%S", time.gmtime(t)) + ".%03d " % int((t % 1) * 1000) + (fmt % args) + "\n")

    def reply(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        if p == "/draft":
            i = (q.get("id") or [""])[0]
            if STATE.get("slowdraft") and not i.startswith("pk_"):
                # 测试用：旧稿故意晚回。先回头、每秒滴一个空格（JSON 前面的空白合法），到时间再给内容——
                # App 的请求超时（6 秒）算的是"多久没收到数据"，这样拖多久都不会被 App 当成连不上
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Connection", "close")
                self.end_headers()
                end = time.time() + STATE["slowdraft"] / 1000.0
                while time.time() < end:
                    self.wfile.write(b" "); self.wfile.flush()
                    time.sleep(min(1.0, max(0.0, end - time.time())))
                self.wfile.write(json.dumps({"id": i, "doc": DRAFTS.get(i)}, ensure_ascii=False).encode("utf-8"))
                self.wfile.flush()
                self.close_connection = True
                return
            return self.reply({"id": i, "doc": DRAFTS.get(i)})
        if p == "/_slowdraft":   # ?ms=2000 让 GET /draft 晚回；ms=0 恢复
            STATE["slowdraft"] = int((q.get("ms") or ["0"])[0] or 0)
            return self.reply({"slowdraft": STATE["slowdraft"]})
        if p == "/status":
            return self.reply({"watcher": {"online": True}, "cli": {"ok": True}, "queue": 0})
        if p in ("/feedback",):
            return self.reply([])
        if p == "/records":
            return self.reply({})
        if p == "/reports":
            return self.reply({"reports": []})
        if p == "/ask/history":
            return self.reply({"threads": []})
        if p == "/mock":
            return self.reply({})
        if p == "/_posts":
            return self.reply(POSTS)
        if p == "/_offline":
            STATE["offline"] = True
            return self.reply({"offline": True})
        if p == "/_resetdrafts":   # 测试用：草稿恢复成开头那份（2009-01 两条旧格式横线）
            DRAFTS.clear(); DRAFTS.update(json.loads(json.dumps(SEED_DRAFTS)))
            return self.reply({"ok": True})
        if p == "/_online":
            STATE["offline"] = False
            return self.reply({"offline": False})
        if p == "/ask/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for i in range(2):
                self.wfile.write(("data: piece%d\n\n" % i).encode())
                self.wfile.flush()
                time.sleep(0.3)
            return
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        p = urlparse(self.path).path
        POSTS.append({"path": p, "len": len(raw)})
        if p == "/draft":
            try:
                body = json.loads(raw.decode("utf-8"))
            except ValueError:
                return self.reply({"error": "bad json", "len": len(raw)}, 400)
            DRAFTS[body.get("id")] = body.get("doc")
            return self.reply({"id": body.get("id"), "ok": True})
        return self.reply({"ok": True})


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print("stub serving", ROOT, "on", PORT, flush=True)
    S(("0.0.0.0", PORT), H).serve_forever()
