"""移動時間の予測手法を実測と比べる（ADR-0005）。本番には載せない。

入力：実証データCSV「移動時間_予測と実測_<期間>.csv」（exportStudyData の出力。複数可）
使い方：python3 analysis/compare_travel_time.py 移動時間_予測と実測_*.csv

比べる手法（同じ区間の集合で比べる。どれかの値が欠ける区間は除く）
- 直線距離の概算 … 直線距離×1.3 ÷ 25km/h（地図なし）
- Google基準 … Routes API の値そのまま
- Google予測 … Google基準 × その時点の補正モデル（アプリが実際に使った値）
- OSRM … OpenStreetMap の経路エンジンの値そのまま（渋滞なし）
- Google×補正(CV)・OSRM×補正(CV) … 区分（移動手段×時間帯×平日/休日）ごとの
  「実測÷基準」の中央値を掛けたもの。
  倍率は評価する日を除いたデータから求める（日ごとの交差検証。同じ日の実測で答え合わせしない）

指標：±10分以内の割合（KPI は 90%）、平均絶対誤差、MAPE、誤差の中央値（＋は長く見積もり）
"""

from __future__ import annotations

import csv
import statistics
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable

KPI_SECONDS = 600
MIN_SAMPLES = 5  # 補正の倍率を求める最小件数（functions の trainFactors と同じ）
RATIO_RANGE = (0.3, 4.0)


def read_rows(paths: Iterable[str]) -> list[dict]:
    rows = []
    for p in paths:
        with open(p, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("補完あり") != "0":
                    continue
                actual = num(r.get("実測秒"))
                if not actual or actual <= 0:
                    continue
                straight = num(r.get("直線距離m"))
                rows.append(
                    {
                        "date": r["日付"],
                        "key": r["区分"],
                        "actual": actual,
                        "google": num(r.get("基準秒")),
                        "predicted": num(r.get("予測秒")),
                        "osrm": num(r.get("OSRM秒")),
                        "straight": straight,
                        "estimate": None if straight is None else straight * 1.3 / 1000 / 25 * 3600,
                    }
                )
    return rows


def num(v: str | None) -> float | None:
    if v is None or v.strip() == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def median_ratio(samples: list[tuple[float, float]]) -> float | None:
    rs = [a / b for a, b in samples if b and b > 60 and RATIO_RANGE[0] <= a / b <= RATIO_RANGE[1]]
    return statistics.median(rs) if len(rs) >= MIN_SAMPLES else None


def corrected(rows: list[dict], base: str) -> list[float]:
    """区分ごとの倍率を、評価する日を除いたデータで求めて掛ける。区分の件数が足りなければ全体の倍率、それも無ければ1"""
    out = []
    for r in rows:
        train = [x for x in rows if x["date"] != r["date"]]
        by_key = [(x["actual"], x[base]) for x in train if x["key"] == r["key"]]
        f = median_ratio(by_key) or median_ratio([(x["actual"], x[base]) for x in train]) or 1.0
        out.append(r[base] * f)
    return out


def metrics(pred: list[float], actual: list[float]) -> dict:
    err = [p - a for p, a in zip(pred, actual, strict=True)]
    return {
        "n": len(err),
        "within10": sum(abs(e) <= KPI_SECONDS for e in err) / len(err),
        "mae": statistics.fmean(abs(e) for e in err),
        "mape": statistics.fmean(abs(e) / a for e, a in zip(err, actual, strict=True)),
        "bias": statistics.median(err),
    }


METHODS: list[tuple[str, Callable[[list[dict]], list[float]]]] = [
    ("直線距離の概算", lambda rs: [r["estimate"] for r in rs]),
    ("Google基準", lambda rs: [r["google"] for r in rs]),
    ("Google予測（アプリの値）", lambda rs: [r["predicted"] for r in rs]),
    ("Google×補正(CV)", lambda rs: corrected(rs, "google")),
    ("OSRM", lambda rs: [r["osrm"] for r in rs]),
    ("OSRM×補正(CV)", lambda rs: corrected(rs, "osrm")),
]


def band(r: dict) -> str:
    m = r["straight"]
    return "2km未満" if m < 2000 else "2〜5km" if m < 5000 else "5km以上"


def report(rows: list[dict]) -> str:
    need = ("google", "predicted", "osrm", "straight")
    full = [r for r in rows if all(r[k] is not None for k in need)]
    lines = [
        f"区間：補完なし {len(rows)} 件のうち、全手法の値がそろう {len(full)} 件で比較",
        "",
    ]
    if not full:
        return "\n".join([*lines, "比べられる区間がない（OSRM秒・直線距離m が空の区間は除外）"])
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in full:
        groups[band(r)].append(r)
    sections = [
        ("全体", full),
        *[(f"直線距離 {b}", groups[b]) for b in ("2km未満", "2〜5km", "5km以上")],
    ]
    for title, rs in sections:
        if not rs:
            continue
        lines += [
            f"## {title}（{len(rs)} 件）",
            "",
            "| 手法 | ±10分以内 | 平均絶対誤差(分) | MAPE | 誤差の中央値(分) |",
            "|---|---|---|---|---|",
        ]
        actual = [r["actual"] for r in rs]
        for name, f in METHODS:
            m = metrics(f(rs), actual)
            cells = [f"{m['within10']:.1%}", f"{m['mae'] / 60:.1f}", f"{m['mape']:.1%}"]
            lines.append(f"| {name} | {' | '.join(cells)} | {m['bias'] / 60:+.1f} |")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    print(report(read_rows(argv)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
