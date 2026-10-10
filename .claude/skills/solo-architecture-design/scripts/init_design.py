#!/usr/bin/env python3
"""プロジェクトに設計用のひな形（docs/ と AGENTS.md）を作る。既存ファイルは上書きしない。

使い方:
  python3 init_design.py <プロジェクトのパス> [--name システム名] [--force]
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"

PLAN = [
    ("prd.md", "docs/prd.md"),
    ("design.md", "docs/design.md"),
    ("openapi.yaml", "docs/api/openapi.yaml"),
    ("adr.md", "docs/adr/_template.md"),
    ("agents.md", "AGENTS.md"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", help="プロジェクトのルートディレクトリ")
    ap.add_argument("--name", help="システム名（ひな形の <システム名> などを置き換える）")
    ap.add_argument("--force", action="store_true", help="既存ファイルも上書きする")
    args = ap.parse_args()

    root = Path(args.project).resolve()
    if not root.is_dir():
        print(f"エラー: ディレクトリがありません: {root}")
        return 1

    created, skipped = [], []
    for src, dst in PLAN:
        target = root / dst
        if target.exists() and not args.force:
            skipped.append(dst)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        text = (TEMPLATES / src).read_text(encoding="utf-8")
        if args.name:
            for ph in ("<システム名>", "<プロダクト名>"):
                text = text.replace(ph, args.name)
        target.write_text(text, encoding="utf-8")
        created.append(dst)
    (root / "docs/handoff").mkdir(parents=True, exist_ok=True)

    for d in created:
        print(f"作成: {d}")
    for d in skipped:
        print(f"スキップ（既存）: {d}")
    print("次の手順: docs/prd.md → docs/design.md → docs/api/openapi.yaml の順に埋め、check_design.py で検査する")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
