#!/usr/bin/env python3
"""設計書（docs/design.md）を検査する。

検査内容:
  - 必須セクションの有無（背景・やらないこと・全体図・コンポーネント・API・デプロイ・代替案・未決事項）
  - 全体図に Mermaid があるか、L1 に技術名が混ざっていないか（縮尺の混在）
  - コンポーネントごとの責務・持つデータ・完了の条件の記入、データの持ち主の重複
  - エラー方針・冪等性の記載
  - ひな形のまま残っているプレースホルダー
  - 未決事項の件数

使い方:
  python3 check_design.py docs/design.md [--json]
終了コード: エラーがあれば 1、なければ 0
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mdutil import find, mermaid_blocks, parse, strip_comments, table_rows  # noqa: E402

REQUIRED = [
    ("背景と目的", ("背景", "目的")),
    ("やらないこと", ("やらないこと", "スコープ外", "non-goal")),
    ("全体図", ("全体図", "アーキテクチャ", "architecture")),
    ("コンポーネントと責務", ("コンポーネント", "component")),
    ("API契約", ("api",)),
    ("デプロイ構成", ("デプロイ", "deploy", "インフラ")),
    ("代替案とトレードオフ", ("代替案", "トレードオフ", "alternative")),
    ("未決事項", ("未決", "open question", "todo")),
]

TECH_WORDS = [
    "Next.js", "React", "Vue", "Angular", "Svelte", "Node.js", "Node", "Deno", "Bun", "Express", "NestJS",
    "Java", "Spring", "Kotlin", "Python", "Django", "FastAPI", "Flask", "Ruby", "Rails", "Go", "Rust", "PHP", "Laravel",
    "PostgreSQL", "Postgres", "MySQL", "SQLite", "MongoDB", "Redis", "DynamoDB", "Firestore",
    "AWS", "GCP", "Azure", "Lambda", "Cloud Run", "Vercel", "Netlify", "Cloudflare", "Supabase", "Firebase",
    "Docker", "Kubernetes", "k8s", "Prisma", "GraphQL", "gRPC", "REST", "HTTPS", "JSON", "SQL",
]

PLACEHOLDER = re.compile(r"<[^<>\n]{1,30}>|〇〇|△△|□□|TBD|xxx", re.I)


def has_content(text: str) -> bool:
    t = strip_comments(text)
    t = re.sub(r"^\s*[-*]\s*(\[ \])?\s*$", "", t, flags=re.M)  # 空の箇条書き
    t = re.sub(r"^\s*\|[\s|:-]*\|\s*$", "", t, flags=re.M)     # 空の表行
    return bool(t.strip())


def field_value(text: str, label: str) -> str | None:
    m = re.search(rf"^\s*[-*]\s*{re.escape(label)}[^:：\n]*[:：]\s*(.*)$", text, flags=re.M)
    return m.group(1).strip() if m else None


def check(path: Path) -> dict:
    md = path.read_text(encoding="utf-8")
    root = parse(md)
    issues: list[dict] = []

    def add(level: str, where: str, msg: str, fix: str = "") -> None:
        issues.append({"level": level, "where": where, "message": msg, "fix": fix})

    # 1. 必須セクション
    found = {}
    for name, keys in REQUIRED:
        sec = find(root, *keys, level=2)
        found[name] = sec
        if sec is None:
            add("ERROR", name, "セクションがありません", f"『## {name}』を追加する（templates/design.md 参照）")
        elif not has_content(sec.full_text):
            add("ERROR" if name in ("コンポーネントと責務", "API契約", "全体図") else "WARN", name, "中身が空です", "記入するか、該当なしなら『なし』と明記する")

    # 2. 図
    arch = found["全体図"]
    if arch is not None:
        blocks = mermaid_blocks(arch.full_text)
        if not blocks:
            add("ERROR", "全体図", "Mermaid の図がありません", "L1・L2 を ```mermaid で描く")
        l1 = find(arch, "L1", "コンテキスト", "context")
        l2 = find(arch, "L2", "コンテナ", "container")
        if l1 is None:
            add("WARN", "全体図", "L1（システムコンテキスト）の見出しがありません", "### L1 システムコンテキスト を追加")
        else:
            body = l1.full_text
            hits = sorted({w for w in TECH_WORDS if re.search(rf"(?<![A-Za-z]){re.escape(w)}(?![A-Za-z])", body)})
            if hits:
                add("WARN", "L1 システムコンテキスト", f"技術名が含まれています（縮尺の混在）: {', '.join(hits)}", "技術名は L2 コンテナ図に移す")
        if l2 is None:
            add("WARN", "全体図", "L2（コンテナ）の見出しがありません", "### L2 コンテナ を追加")
        for i, b in enumerate(blocks, 1):
            arrows = re.findall(r"--+>|-\.->|==>", b)
            labeled = re.findall(r"--+>\s*\|[^|]+\||-- [^-]+ -->", b)
            if arrows and not labeled and "sequenceDiagram" not in b:
                add("INFO", f"図{i}", "矢印にラベルがありません", "矢印に『何を・どの方式で』を書く（例: -->|HTTPS/JSON|）")

    # 3. コンポーネント
    comp = found["コンポーネントと責務"]
    owners: dict[str, list[str]] = {}
    if comp is not None:
        subs = [c for c in comp.children if c.level == 3]
        if not subs:
            add("WARN", "コンポーネントと責務", "コンポーネントごとの ### 見出しがありません", "コンポーネントごとに ### 見出しを作る（make_handoff.py が使う）")
        for c in subs:
            where = f"コンポーネント「{c.title}」"
            if PLACEHOLDER.search(c.title):
                add("WARN", where, "見出しがひな形のままです", "実際のコンポーネント名にする")
            body = strip_comments(c.full_text)
            for label in ("責務", "持つデータ", "完了の条件"):
                v = field_value(body, label)
                if v is None:
                    add("WARN", where, f"『{label}』がありません", f"- {label}： を追加する")
                elif not v and label != "完了の条件":
                    add("WARN", where, f"『{label}』が空です", "記入する（なければ『なし』）")
            if "完了の条件" in body and not re.search(r"\[[ x]\]\s*\S", body):
                add("WARN", where, "完了の条件に具体的な項目がありません", "テストで確認できる条件を - [ ] で書く")
            data = field_value(body, "持つデータ")
            if data and data not in ("なし", "-", "ー"):
                for d in re.split(r"[、,，/／・]", re.sub(r"[（(].*?[)）]", "", data)):
                    d = d.strip()
                    if d:
                        owners.setdefault(d, []).append(c.title)
        for d, cs in owners.items():
            if len(cs) > 1:
                add("ERROR", "データの持ち主", f"「{d}」の持ち主が複数あります: {', '.join(cs)}", "持ち主を1つに決め、他はAPI経由で参照する")
        if len(subs) > 12:
            add("INFO", "コンポーネントと責務", f"コンポーネントが {len(subs)} 個あります", "個人開発では細かすぎないか確認する（decision-guide.md 1節）")

    # 4. API・エラー・冪等性
    api = found["API契約"]
    whole = strip_comments(md)
    if api is not None:
        if not re.search(r"エラー|error", api.full_text, re.I):
            add("ERROR", "API契約", "エラーの定義がありません", "エラーコード・意味・呼び出し側の対応を表にする")
        rows = [r for r in table_rows(strip_comments(api.full_text)) if any(r)]
        if not rows and "openapi" not in api.full_text.lower():
            add("WARN", "API契約", "API一覧の表も OpenAPI への参照もありません", "一覧表を書くか docs/api/openapi.yaml を参照する")
        for r in rows:
            for cell in r:
                if re.search(r"/(get|create|update|delete|fetch|add|remove)[A-Z_-]?", cell, re.I):
                    add("WARN", "API契約", f"パスに動詞が含まれています: {cell}", "動詞はHTTPメソッドかカスタムメソッド（:verb）で表す")
    if not re.search(r"冪等|idempoten|request_id|Idempotency", whole, re.I):
        add("WARN", "API契約", "冪等性（再試行時の扱い）の記載がありません", "作成・決済など副作用のある操作の再試行方針を書く")
    if not re.search(r"タイムアウト|timeout", whole, re.I):
        add("INFO", "API契約", "タイムアウトの記載がありません", "外部・ネットワーク越しの呼び出しのタイムアウトと失敗時の扱いを書く")

    # 5. デプロイ・秘密情報
    dep = found["デプロイ構成"]
    if dep is not None and not re.search(r"秘密|シークレット|secret|環境変数", dep.full_text, re.I):
        add("WARN", "デプロイ構成", "秘密情報の置き場所が書かれていません", "APIキーやDB接続情報の管理方法を書く")

    # 6. プレースホルダー
    ph = []
    in_code = False
    for n, line in enumerate(md.splitlines(), 1):
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        clean = strip_comments(line)
        clean = re.sub(r"<br\s*/?>", "", clean)
        if PLACEHOLDER.search(clean):
            ph.append(n)
    if ph:
        add("WARN", "全体", f"ひな形のプレースホルダーが残っています（行 {', '.join(map(str, ph[:10]))}{' ほか' if len(ph) > 10 else ''}）", "実際の内容に置き換える")

    # 7. 未決事項
    open_items = 0
    if found["未決事項"] is not None:
        txt = strip_comments(found["未決事項"].full_text)
        open_items = len([r for r in table_rows(txt) if any(r)]) + len(re.findall(r"^\s*[-*]\s+\S", txt, re.M))

    summary = {
        "file": str(path),
        "errors": sum(i["level"] == "ERROR" for i in issues),
        "warnings": sum(i["level"] == "WARN" for i in issues),
        "infos": sum(i["level"] == "INFO" for i in issues),
        "components": len([c for c in comp.children if c.level == 3]) if comp else 0,
        "open_items": open_items,
    }
    return {"summary": summary, "issues": issues}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("design", help="設計書のパス（例: docs/design.md）")
    ap.add_argument("--json", action="store_true", help="JSONで出力する")
    args = ap.parse_args()
    p = Path(args.design)
    if not p.is_file():
        print(f"エラー: ファイルがありません: {p}")
        return 1
    res = check(p)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        s = res["summary"]
        print(f"# 設計書チェック: {s['file']}")
        print(f"エラー {s['errors']} / 警告 {s['warnings']} / 情報 {s['infos']} ｜ コンポーネント {s['components']} ｜ 未決事項 {s['open_items']}")
        order = {"ERROR": 0, "WARN": 1, "INFO": 2}
        for i in sorted(res["issues"], key=lambda x: order[x["level"]]):
            print(f"- [{i['level']}] {i['where']}: {i['message']}" + (f"\n    → {i['fix']}" if i["fix"] else ""))
        if not res["issues"]:
            print("問題は見つかりませんでした。review-checklist.md で内容面を確認してください。")
    return 1 if res["summary"]["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
