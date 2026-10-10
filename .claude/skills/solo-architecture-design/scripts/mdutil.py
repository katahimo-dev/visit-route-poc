"""設計書（Markdown）を見出し単位で扱う小さなユーティリティ。標準ライブラリのみ。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


@dataclass
class Section:
    level: int
    title: str
    lines: list[str] = field(default_factory=list)
    children: list["Section"] = field(default_factory=list)

    @property
    def text(self) -> str:
        """自分の本文（子見出しの本文は含まない）。"""
        return "\n".join(self.lines).strip()

    @property
    def full_text(self) -> str:
        """子見出しを含めた本文（見出し行も含む）。"""
        out = list(self.lines)
        for c in self.children:
            out.append("#" * c.level + " " + c.title)
            out.append(c.full_text)
        return "\n".join(out).strip()


def parse(md: str) -> Section:
    """見出しの木構造に分解する。コードブロック内の # は見出しとして扱わない。"""
    root = Section(0, "")
    stack = [root]
    in_code = False
    for line in md.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
        m = None if in_code else HEADING.match(line)
        if m:
            level = len(m.group(1))
            sec = Section(level, m.group(2))
            while stack[-1].level >= level:
                stack.pop()
            stack[-1].children.append(sec)
            stack.append(sec)
        else:
            stack[-1].lines.append(line)
    return root


def find(root: Section, *keywords: str, level: int | None = None) -> Section | None:
    """タイトルにいずれかのキーワードを含む最初の見出しを返す（深さ優先）。"""
    for c in root.children:
        if (level is None or c.level == level) and any(k.lower() in c.title.lower() for k in keywords):
            return c
        hit = find(c, *keywords, level=level)
        if hit:
            return hit
    return None


def strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def mermaid_blocks(text: str) -> list[str]:
    return re.findall(r"```mermaid\s*\n(.*?)```", text, flags=re.S)


def table_rows(text: str) -> list[list[str]]:
    """Markdownの表を行のリストに（見出し行・区切り行は除く）。"""
    rows = []
    lines = [l for l in text.splitlines() if l.strip().startswith("|")]
    for i, l in enumerate(lines):
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        if i == 0 or all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        rows.append(cells)
    return rows
