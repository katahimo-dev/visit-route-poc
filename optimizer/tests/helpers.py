"""テスト用の入力ビルダー。"""

from __future__ import annotations

import random


def hhmm(sec: int) -> str:
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}"


def mins(s: str) -> int:
    return int(s[:2]) * 60 + int(s[3:])


def staff(sid, start, end=None, shift=("09:00", "18:00"), gender=None, max_visits=None):
    d = {
        "staffId": sid,
        "startPoint": start,
        "endPoint": start if end is None else end,
        "shiftStart": shift[0],
        "shiftEnd": shift[1],
    }
    if gender:
        d["gender"] = gender
    if max_visits is not None:
        d["maxVisits"] = max_visits
    return d


def visit(vid, point, dur=30, window=("09:00", "17:00"), kind="window", **kw):
    d = {
        "visitId": vid,
        "point": point,
        "durationMinutes": dur,
        "window": {"kind": kind, "earliestStart": window[0], "latestStart": window[1]},
    }
    d.update(kw)
    return d


def request(staff_list, visits, seconds, mode="assign_and_order", **extra):
    n = len(seconds)
    body = {
        "requestId": "run-1",
        "mode": mode,
        "date": "2026-10-12",
        "staff": staff_list,
        "visits": visits,
        "matrix": {
            "points": [{"id": f"p/{i}"} for i in range(n)],
            "seconds": seconds,
            "modelVersion": "test",
        },
        "limits": {"timeLimitSeconds": 5, "solutionLimit": 200},
    }
    body.update(extra)
    return body


def line_matrix(coords, speed=10):
    """1次元座標から対称行列を作る（秒 = 距離 × speed）。"""
    return [[abs(a - b) * speed for b in coords] for a in coords]


def random_scenario(n_staff=8, n_visits=30, seed=1):
    rng = random.Random(seed)
    pts = [(rng.random() * 10, rng.random() * 10) for _ in range(n_staff + n_visits)]
    n = len(pts)
    seconds = [
        [
            int(((pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2) ** 0.5 * 180)
            for j in range(n)
        ]
        for i in range(n)
    ]
    staff_list = [
        staff(f"s{i}", i, gender=rng.choice(["female", "male"])) for i in range(n_staff)
    ]
    visits = []
    for k in range(n_visits):
        e = rng.choice([9, 10, 11, 13, 14, 15]) * 60
        visits.append(
            visit(
                f"v{k}",
                n_staff + k,
                dur=rng.choice([30, 45, 60]),
                window=(hhmm(e * 60), hhmm((e + 120) * 60)),
            )
        )
    return request(staff_list, visits, seconds)
