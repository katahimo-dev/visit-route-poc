#!/usr/bin/env python3
"""設計書から、1つのコンポーネント用の AIエージェント作業指示書を生成する。

設計書の「## コンポーネントと責務」配下の ### 見出し（コンポーネント名）と、
「## API契約」の表のうち、そのコンポーネントの行・エラー方針・冪等性の記述を抜き出し、
templates/handoff.md に流し込む。

使い方:
  python3 make_handoff.py docs/design.md "注文サービス" [-o docs/handoff/order.md]
  python3 make_handoff.py docs/design.md --list    # コンポーネント一覧を表示
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mdutil import find, parse, strip_comments, table_rows  # noqa: E402

TEMPLATE = Path(__file__).resolve().parent.parent / "templates" / "handoff.md"


def components(root):
    sec = find(root, "コンポーネント", "component", level=2)
    return sec, ([c for c in sec.children if c.level == 3] if sec else [])


def api_part(root, name: str) -> str:
    sec = find(root, "api", level=2)
    if sec is None:
        return "（設計書に API契約 のセクションがありません。作業を始める前に契約を決めてください）"
    # API一覧は「## API契約」直下の本文の最初の表だけを使う（エラー方針などの表は含めない）
    text = strip_comments(sec.text)
    lines = []
    for l in text.splitlines():
        if l.strip().startswith("|"):
            lines.append(l)
        elif lines:
            break
    header = lines[:2] if len(lines) >= 2 else []
    mine = [l for l in lines[2:] if name in l.split("|")[1]] if header else []
    out = []
    if mine:
        out.append("### 提供するAPI")
        out += header + mine
    else:
        out.append("### 提供するAPI")
        out.append("（API一覧の表にこのコンポーネントの行がありません。docs/api/ を確認するか、契約を追加してください）")
    for sub in sec.children:
        if any(k in sub.title for k in ("エラー", "冪等", "タイムアウト", "error")):
            out.append("")
            out.append(f"### {sub.title}")
            out.append(strip_comments(sub.full_text))
    # 他コンポーネントのAPI（呼び出す可能性がある）
    others = [l for l in lines[2:] if l not in mine]
    if header and others:
        out.append("")
        out.append("### 呼び出してよい他コンポーネントのAPI（参考）")
        out += header + others
    return "\n".join(out).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("design")
    ap.add_argument("component", nargs="?", help="コンポーネント名（### 見出しの一部でよい）")
    ap.add_argument("-o", "--output", help="出力先。省略時は標準出力")
    ap.add_argument("--list", action="store_true", help="コンポーネント一覧を表示する")
    args = ap.parse_args()

    root = parse(Path(args.design).read_text(encoding="utf-8"))
    _, comps = components(root)
    if args.list or not args.component:
        if not comps:
            print("コンポーネントの ### 見出しが見つかりません")
            return 1
        for c in comps:
            print(f"- {c.title}")
        return 0

    hits = [c for c in comps if args.component.lower() in c.title.lower()]
    if not hits:
        print(f"エラー: コンポーネント「{args.component}」が見つかりません。候補: {', '.join(c.title for c in comps) or 'なし'}")
        return 1
    if len(hits) > 1:
        print(f"エラー: 複数一致しました: {', '.join(c.title for c in hits)}。もっと具体的に指定してください")
        return 1
    comp = hits[0]

    bg = find(root, "背景", "目的", level=2)
    ng = find(root, "やらないこと", "スコープ外", level=2)
    text = TEMPLATE.read_text(encoding="utf-8")
    text = (
        text.replace("{{component}}", comp.title)
        .replace("{{section}}", strip_comments(comp.full_text) or "（記載なし）")
        .replace("{{api}}", api_part(root, comp.title))
        .replace("{{background}}", strip_comments(bg.full_text) if bg else "（記載なし）")
        .replace("{{nongoals}}", strip_comments(ng.full_text) if ng else "（記載なし）")
    )
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"作成: {out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
