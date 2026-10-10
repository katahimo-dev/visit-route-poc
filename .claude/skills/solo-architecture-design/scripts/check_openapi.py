#!/usr/bin/env python3
"""OpenAPI の契約を、このスキルの方針で検査する（仕様の厳密な検証ではない）。

検査内容:
  - operationId の有無、標準メソッド（Create/Get/List/Update/Delete）かカスタムか
  - エラー応答（4xx/5xx/default）の定義
  - パスに動詞が入っていないか
  - コレクションの GET にページング（page_size / page_token など）があるか
  - POST の作成系に冪等性キー（Idempotency-Key / request_id）があるか
  - エラーのスキーマが定義されているか
  - 説明（summary / description）の有無

使い方:
  python3 check_openapi.py docs/api/openapi.yaml [--json]
YAML の読み込みには PyYAML を使う（なければ JSON 形式のみ対応）。
終了コード: エラーがあれば 1
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

METHODS = ("get", "post", "put", "patch", "delete")
STANDARD = ("Create", "Get", "List", "Update", "Delete")
VERB_IN_PATH = re.compile(r"^(get|create|update|delete|fetch|add|remove|list|make|do|set)([A-Z_-]|$)", re.I)
PAGING = {"page_size", "page_token", "pagesize", "pagetoken", "limit", "cursor", "offset", "per_page", "page"}
IDEMPOTENCY = {"idempotency-key", "x-idempotency-key", "request_id", "requestid", "x-request-id"}


def load(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except ImportError:
            print("エラー: YAML を読むには PyYAML が必要です（pip install pyyaml）。または JSON に変換してください。")
            sys.exit(2)
        return yaml.safe_load(text)
    return json.loads(text)


def resolve(doc: dict, obj):
    """$ref を1段だけ解決する。"""
    if isinstance(obj, dict) and "$ref" in obj and obj["$ref"].startswith("#/"):
        cur = doc
        for part in obj["$ref"][2:].split("/"):
            cur = cur.get(part, {}) if isinstance(cur, dict) else {}
        return cur
    return obj


def check(doc: dict) -> dict:
    issues = []

    def add(level, where, msg, fix=""):
        issues.append({"level": level, "where": where, "message": msg, "fix": fix})

    paths = doc.get("paths") or {}
    if not paths:
        add("ERROR", "paths", "API が1つも定義されていません")
    schemas = (doc.get("components") or {}).get("schemas") or {}
    if not any("error" in k.lower() for k in schemas):
        add("WARN", "components.schemas", "エラーのスキーマ（Error など）がありません", "エラー本文の形（code / message / details）を定義して全APIで共有する")

    ops = 0
    for p, item in paths.items():
        segs = [s for s in p.split("/") if s and not s.startswith("{")]
        for s in segs:
            base = s.split(":")[0]
            if VERB_IN_PATH.match(base):
                add("WARN", p, f"パスに動詞が含まれています（{base}）", "名詞のパスにし、動詞は HTTP メソッドかカスタムメソッド（/resource:verb）で表す")
        path_params = [resolve(doc, x) for x in (item.get("parameters") or [])]
        for m in METHODS:
            op = item.get(m)
            if not op:
                continue
            ops += 1
            where = f"{m.upper()} {p}"
            oid = op.get("operationId")
            if not oid:
                add("ERROR", where, "operationId がありません", "例: ListBooks / CreateBook")
            elif not oid.startswith(STANDARD):
                add("INFO", where, f"カスタムメソッドです（{oid}）", "標準メソッドで表現できないか確認する")
            if not (op.get("summary") or op.get("description")):
                add("INFO", where, "説明（summary）がありません", "何をするAPIか1行で書く")
            responses = {str(k) for k in (op.get("responses") or {})}
            if not responses:
                add("ERROR", where, "responses がありません")
            elif not any(r == "default" or r.startswith(("4", "5")) for r in responses):
                add("ERROR", where, "エラー応答が定義されていません", "4xx / 5xx / default にエラーのスキーマを定義する")
            params = path_params + [resolve(doc, x) for x in (op.get("parameters") or [])]
            names = {str(x.get("name", "")).lower() for x in params if isinstance(x, dict)}
            is_collection = not p.rstrip("/").endswith("}") and ":" not in p.rsplit("/", 1)[-1]
            if m == "get" and is_collection and not (names & PAGING):
                add("WARN", where, "一覧にページングがありません", "page_size と page_token を追加する（後から足すと互換性が壊れる）")
            if m == "post" and is_collection:
                body_props = set()
                rb = resolve(doc, op.get("requestBody") or {})
                for media in (rb.get("content") or {}).values():
                    sch = resolve(doc, media.get("schema") or {})
                    body_props |= {k.lower() for k in (sch.get("properties") or {})}
                if not ((names | body_props) & IDEMPOTENCY):
                    add("WARN", where, "作成系に冪等性キーがありません", "Idempotency-Key ヘッダか request_id を受け取り、再試行で二重作成しないようにする")
    return {
        "summary": {
            "operations": ops,
            "errors": sum(i["level"] == "ERROR" for i in issues),
            "warnings": sum(i["level"] == "WARN" for i in issues),
            "infos": sum(i["level"] == "INFO" for i in issues),
        },
        "issues": issues,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", help="OpenAPI ファイル（.yaml / .yml / .json）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    p = Path(args.spec)
    if not p.is_file():
        print(f"エラー: ファイルがありません: {p}")
        return 1
    res = check(load(p))
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        s = res["summary"]
        print(f"# OpenAPI チェック: {p}")
        print(f"API {s['operations']} 件 ｜ エラー {s['errors']} / 警告 {s['warnings']} / 情報 {s['infos']}")
        order = {"ERROR": 0, "WARN": 1, "INFO": 2}
        for i in sorted(res["issues"], key=lambda x: order[x["level"]]):
            print(f"- [{i['level']}] {i['where']}: {i['message']}" + (f"\n    → {i['fix']}" if i["fix"] else ""))
        if not res["issues"]:
            print("問題は見つかりませんでした。")
    return 1 if res["summary"]["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
