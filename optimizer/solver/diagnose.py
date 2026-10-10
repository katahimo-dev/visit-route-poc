"""未割当の訪問の原因を、訪問ごとに単独で診断する（純粋関数）。

判定の順序（最初に当てはまったものを1つ返す）:
  gender      … 性別希望を満たすスタッフがいない
  ng_staff    … 性別を満たすスタッフがみなNG
  unreachable … 候補スタッフの全員が、出発地→訪問先 または 訪問先→帰宅先 に到達できない
  shift       … 候補のどのスタッフの勤務時間にも、この訪問だけでも収まらない
  time_window … 上のどれでもない（他の訪問との組み合わせ・最大訪問数で入りきらない）
"""

from __future__ import annotations

from .request import SolveRequest, Staff, Visit


def eligible_staff(req: SolveRequest, visit: Visit) -> list[Staff]:
    """モード・性別希望・NG を通るスタッフ（求解の割当可否と同じ規則）。"""
    pool = req.staff
    if req.mode == "order_only":
        pool = [s for s in pool if s.staff_id == visit.current_staff_id]
    out = []
    for s in pool:
        if visit.required_gender is not None and s.gender != visit.required_gender:
            continue
        if s.staff_id in visit.ng_staff_ids:
            continue
        out.append(s)
    return out


def diagnose(req: SolveRequest, visit: Visit) -> list[str]:
    pool = req.staff
    if req.mode == "order_only":
        pool = [s for s in pool if s.staff_id == visit.current_staff_id]

    by_gender = [
        s for s in pool if visit.required_gender is None or s.gender == visit.required_gender
    ]
    if not by_gender:
        return ["gender"]
    candidates = [s for s in by_gender if s.staff_id not in visit.ng_staff_ids]
    if not candidates:
        return ["ng_staff"]

    sec = req.seconds
    reachable = []
    for s in candidates:
        go = sec[s.start_point][visit.point]
        back = sec[visit.point][s.end_point]
        if go >= 0 and back >= 0:
            reachable.append((s, go, back))
    if not reachable:
        return ["unreachable"]

    for s, go, back in reachable:
        start = max(s.shift_start + go, visit.earliest_start)
        if start <= visit.latest_start and start + visit.duration_seconds + back <= s.shift_end:
            return ["time_window"]  # 単独なら収まる＝他との組み合わせが原因
    return ["shift"]
