"""求解の入口。検証 → 求解 → 契約どおりの応答に組み立てる。"""

from __future__ import annotations

import time
from typing import Any

import ortools

from .diagnose import avoid_breaks
from .request import SolveRequest, parse_request
from .routing import solve_routing, unassigned_with_reasons

SOLVER_VERSION = "0.1.0"


def ortools_version() -> str:
    return str(ortools.__version__)


def _fmt(seconds: int) -> str:
    """秒 → HH:MM（切り捨て）。時間枠は分単位なので、切り捨てで枠を超えて見えることはない。"""
    m = max(seconds, 0) // 60
    return f"{m // 60:02d}:{m % 60:02d}"


def _overlap(a: int, b: int, breaks: tuple[tuple[int, int], ...]) -> int:
    """区間 [a, b) が休みと重なる秒数。"""
    return sum(max(0, min(b, be) - max(a, bs)) for bs, be in breaks)


def _build_route(req: SolveRequest, staff_idx: int, seq: list[int]) -> tuple[dict, int, int, int]:
    """順番から時刻を前詰めで再計算する。戻り値: (route, 移動秒, 待ち秒, メートル)。"""
    s = req.staff[staff_idx]
    sec, met = req.seconds, req.meters
    stops: list[dict] = []
    travel_total = wait_total = meters_total = 0
    t = s.shift_start
    prev_point = s.start_point
    prev_visit = None
    for k, vi in enumerate(seq):
        v = req.visits[vi]
        leg = sec[prev_point][v.point]
        gap = v.min_gap_seconds if prev_visit is not None else 0
        arrival = t + leg + gap
        start = max(arrival, v.earliest_start)
        # 作業が休みにかかるなら休み明けまで遅らせる（求解でも同じ条件を課している）。
        # 移動は休みにかかってよいので、到着は前詰めのまま
        start = avoid_breaks(start, v.duration_seconds, s.breaks)
        if k == 0:
            # 出発を遅らせて、最初の訪問先では待たない（待つなら自宅で待つ）
            depart = max(s.shift_start, start - leg)
            arrival = depart + leg
        # 待ちは到着から開始までのうち、休みでない時間（休みは待ちに数えない）
        wait = start - arrival - _overlap(arrival, start, s.breaks)
        # 表示は分に切り捨てた時刻の差（休みは分単位なので、切り捨てた到着から数える）
        a_min = arrival // 60 * 60
        wait_minutes = max(0, (start // 60 * 60 - a_min - _overlap(a_min, start, s.breaks)) // 60)
        stops.append(
            {
                "visitId": v.visit_id,
                "arrival": _fmt(arrival),
                "start": _fmt(start),
                "end": _fmt(start + v.duration_seconds),
                "waitMinutes": wait_minutes,
            }
        )
        travel_total += leg
        wait_total += wait
        if met is not None:
            meters_total += max(met[prev_point][v.point], 0)
        t = start + v.duration_seconds
        prev_point = v.point
        prev_visit = v
    if seq:
        travel_total += max(sec[prev_point][s.end_point], 0)
        if met is not None:
            meters_total += max(met[prev_point][s.end_point], 0)
    return {"staffId": s.staff_id, "stops": stops}, travel_total, wait_total, meters_total


def solve(body: Any) -> dict:
    """リクエスト本文（dict）を解いて SolveResponse（dict）を返す。入力不正は InvalidArgument。"""
    req = parse_request(body)
    t0 = time.monotonic()
    raw = solve_routing(req)

    routes, travel, wait, meters = [], 0, 0, 0
    for i, seq in enumerate(raw.routes):
        route, tr, wa, me = _build_route(req, i, seq)
        routes.append(route)
        travel += tr
        wait += wa
        meters += me

    stats: dict[str, int] = {"totalTravelSeconds": travel, "totalWaitSeconds": wait}
    if req.meters is not None:
        stats["totalMeters"] = meters
    stats["computeMillis"] = int((time.monotonic() - t0) * 1000)
    return {
        "requestId": req.request_id,
        "routes": routes,
        "unassigned": unassigned_with_reasons(req, raw.dropped),
        "partial": raw.hit_time_limit,
        "stats": stats,
        "solverVersion": SOLVER_VERSION,
    }
