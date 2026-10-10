"""Firebase 入口（ルーターとエラー形）のテスト。Firebase 実環境なしで handle() を呼ぶ。"""

from __future__ import annotations

import json

from helpers import line_matrix, request, staff, visit

from main import handle


def call(method, path, body=None):
    res = handle(method, path, lambda: body)
    return res.status_code, json.loads(res.get_data(as_text=True))


def test_version():
    code, body = call("GET", "/v1/version")
    assert code == 200
    assert body["solverVersion"] == "0.1.0" and body["ortoolsVersion"]


def test_solve_ok_with_prefixed_path():
    req = request([staff("a", 0)], [visit("v", 1)], line_matrix([0, 5]))
    code, body = call("POST", "/optimizer/v1/plans:solve", req)
    assert code == 200 and body["routes"][0]["stops"][0]["visitId"] == "v"


def test_invalid_argument_shape():
    req = request([staff("a", 0)], [visit("v", 1)], line_matrix([0, 5]))
    req["mode"] = "bogus"
    code, body = call("POST", "/v1/plans:solve", req)
    assert code == 400
    err = body["error"]
    assert err["code"] == "INVALID_ARGUMENT" and "mode" in err["details"]["fields"]
    assert any("぀" <= ch <= "鿿" for ch in err["message"])


def test_bad_json():
    def loader():
        raise ValueError("x")

    res = handle("POST", "/v1/plans:solve", loader)
    assert res.status_code == 400


def test_unknown_route_and_method():
    assert call("GET", "/v1/plans:solve")[0] == 405
    assert call("GET", "/nope")[0] == 404
