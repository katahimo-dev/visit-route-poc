"""ローカル開発用のHTTPサーバー。

Functions エミュレーターから OPTIMIZER_URL=http://127.0.0.1:8090 で呼ぶ。

    cd optimizer && uv run python dev_server.py

本番では使わない（本番は main.py の Cloud Functions）。ルーティングは main.handle と同じ。
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from main import handle

PORT = 8090


class Handler(BaseHTTPRequestHandler):
    def _run(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        res = handle(self.command, self.path, lambda: json.loads(raw or b"null"))
        body = res.get_data()
        self.send_response(res.status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _run
    do_POST = _run


if __name__ == "__main__":
    print(f"optimizer dev server: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
