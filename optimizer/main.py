"""Firebase Cloud Functions 2nd gen（Python）の入口。薄いルーターで、業務ロジックは solver/ にある。

  POST …/v1/plans:solve → 求解
  GET  …/v1/version     → ソルバーの版
エラーは契約の Error 形 {"error": {"code", "message", "details"}} で返す。
"""

from __future__ import annotations

import json
import logging

from firebase_functions import https_fn, options

from solver import SOLVER_VERSION, InvalidArgument, ortools_version, solve

# 契約の code 列挙（INVALID_ARGUMENT / UNAUTHENTICATED / PERMISSION_DENIED / UNAVAILABLE /
# INTERNAL）の範囲で返す。経路・メソッド違いは code=INVALID_ARGUMENT のまま HTTP 404/405 にする。


def _json(payload: dict, status: int = 200) -> https_fn.Response:
    return https_fn.Response(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        content_type="application/json; charset=utf-8",
    )


def _error(
    code: str, message: str, details: dict | None = None, status: int | None = None
) -> https_fn.Response:
    body: dict = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return _json({"error": body}, status or (500 if code == "INTERNAL" else 400))


def handle(method: str, path: str, body_loader) -> https_fn.Response:
    """ルーティング本体（テストしやすいよう Request から切り離してある）。"""
    path = path.rstrip("/")
    try:
        if path.endswith("/v1/plans:solve"):
            if method != "POST":
                return _error("INVALID_ARGUMENT", "POST で呼び出してください", status=405)
            try:
                body = body_loader()
            except (ValueError, TypeError):
                return _error(
                    "INVALID_ARGUMENT",
                    "リクエストがJSONとして読めません",
                    {"fields": {"body": "JSONとして読めません"}},
                )
            return _json(solve(body))
        if path.endswith("/v1/version"):
            if method != "GET":
                return _error("INVALID_ARGUMENT", "GET で呼び出してください", status=405)
            return _json({"solverVersion": SOLVER_VERSION, "ortoolsVersion": ortools_version()})
        return _error("INVALID_ARGUMENT", "対象が見つかりません", status=404)
    except InvalidArgument as e:
        return _error("INVALID_ARGUMENT", "入力が正しくありません", {"fields": e.fields})
    except Exception:
        # 内部の例外文言は返さない（ログのみ。位置・氏名・住所は出さない）
        logging.exception("optimizer internal error")
        return _error("INTERNAL", "最適化サービスで想定外のエラーが起きました")


@https_fn.on_request(
    region="asia-northeast1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=60,
    invoker="private",
    max_instances=3,
)
def optimizer(req: https_fn.Request) -> https_fn.Response:
    return handle(req.method, req.path, lambda: req.get_json(force=True))
