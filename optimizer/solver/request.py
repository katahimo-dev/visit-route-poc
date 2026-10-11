"""リクエストの検証とデータクラスへの変換（pydantic 不使用の素朴な検証）。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date as _date
from typing import Any

from .errors import InvalidArgument

_HHMM = re.compile(r"^(\d{2}):(\d{2})$")

DEFAULT_TRAVEL_WEIGHT = 1.0
DEFAULT_WAIT_WEIGHT = 0.3
DEFAULT_TIME_LIMIT_SECONDS = 20
DEFAULT_SOLUTION_LIMIT = 2000
MAX_BREAKS = 4


@dataclass(frozen=True)
class Staff:
    staff_id: str
    gender: str | None
    start_point: int
    end_point: int
    shift_start: int  # 00:00 からの秒
    shift_end: int
    max_visits: int | None
    # 勤務時間の中の休み [(開始秒, 終了秒), ...]。開始の順・重なりなし・勤務時間の内側（ADR-0008）
    breaks: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True)
class Visit:
    visit_id: str
    point: int
    duration_seconds: int
    earliest_start: int
    latest_start: int
    current_staff_id: str | None
    required_gender: str | None
    ng_staff_ids: frozenset[str]
    min_gap_seconds: int


@dataclass(frozen=True)
class SolveRequest:
    request_id: str
    mode: str
    date: str
    staff: list[Staff]
    visits: list[Visit]
    seconds: list[list[int]]
    meters: list[list[int]] | None
    travel_weight: float
    wait_weight: float
    time_limit_seconds: int
    solution_limit: int


def _hhmm(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    m = _HHMM.match(value)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return h * 3600 + mi * 60


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def parse_request(body: Any) -> SolveRequest:
    """検証して SolveRequest にする。違反は InvalidArgument(fields) で全項目まとめて返す。"""
    errs: dict[str, str] = {}
    if not isinstance(body, dict):
        raise InvalidArgument({"body": "JSONオブジェクトで指定してください"})

    request_id = body.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        errs["requestId"] = "必須の文字列です"
    mode = body.get("mode")
    if mode not in ("order_only", "assign_and_order"):
        errs["mode"] = "order_only または assign_and_order を指定してください"
    date_s = body.get("date")
    try:
        if not isinstance(date_s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_s):
            raise ValueError
        _date.fromisoformat(date_s)
    except ValueError:
        errs["date"] = "YYYY-MM-DD 形式で指定してください"

    # --- matrix ---
    matrix = body.get("matrix")
    n_points = 0
    seconds: list[list[int]] = []
    meters: list[list[int]] | None = None
    if not isinstance(matrix, dict):
        errs["matrix"] = "必須のオブジェクトです"
    else:
        points = matrix.get("points")
        if not isinstance(points, list) or not all(
            isinstance(p, dict) and isinstance(p.get("id"), str) for p in points
        ):
            errs["matrix.points"] = "id を持つ要素の配列で指定してください"
        else:
            n_points = len(points)
        if not isinstance(matrix.get("modelVersion"), str):
            errs["matrix.modelVersion"] = "必須の文字列です"
        seconds_raw = matrix.get("seconds")
        if "matrix.points" not in errs:
            ok, seconds = _check_square(seconds_raw, n_points, allow_negative=True)
            if not ok:
                errs["matrix.seconds"] = (
                    "points × points の整数行列で指定してください（到達不能は -1）"
                )
            if matrix.get("meters") is not None:
                ok, meters_v = _check_square(matrix["meters"], n_points, allow_negative=True)
                if ok:
                    meters = meters_v
                else:
                    errs["matrix.meters"] = "points × points の整数行列で指定してください"

    # --- staff ---
    staff_list: list[Staff] = []
    staff_raw = body.get("staff")
    if not isinstance(staff_raw, list) or not (1 <= len(staff_raw) <= 30):
        errs["staff"] = "1〜30件の配列で指定してください"
        staff_raw = []
    seen: set[str] = set()
    for i, s in enumerate(staff_raw):
        p = f"staff[{i}]"
        if not isinstance(s, dict):
            errs[p] = "オブジェクトで指定してください"
            continue
        sid = s.get("staffId")
        if not isinstance(sid, str) or not sid:
            errs[f"{p}.staffId"] = "必須の文字列です"
        elif sid in seen:
            errs[f"{p}.staffId"] = "staffId が重複しています"
        else:
            seen.add(sid)
        gender = s.get("gender")
        if gender is not None and gender not in ("female", "male", "unspecified"):
            errs[f"{p}.gender"] = "female / male / unspecified のいずれかです"
        sp, ep = s.get("startPoint"), s.get("endPoint")
        for key, val in (("startPoint", sp), ("endPoint", ep)):
            if not _is_int(val) or not (0 <= val < n_points):
                errs[f"{p}.{key}"] = "matrix.points の範囲内の整数で指定してください"
        ss, se = _hhmm(s.get("shiftStart")), _hhmm(s.get("shiftEnd"))
        if ss is None:
            errs[f"{p}.shiftStart"] = "HH:MM 形式で指定してください"
        if se is None:
            errs[f"{p}.shiftEnd"] = "HH:MM 形式で指定してください"
        if ss is not None and se is not None and ss >= se:
            errs[f"{p}.shiftEnd"] = "shiftStart より後の時刻にしてください"
        mv = s.get("maxVisits")
        if mv is not None and (not _is_int(mv) or mv < 0):
            errs[f"{p}.maxVisits"] = "0以上の整数で指定してください"
        breaks = _parse_breaks(s.get("breaks"), ss, se, f"{p}.breaks", errs)
        if not any(k.startswith(p) for k in errs):
            staff_list.append(Staff(sid, gender, sp, ep, ss, se, mv, breaks))

    # --- visits ---
    visit_list: list[Visit] = []
    visits_raw = body.get("visits")
    if not isinstance(visits_raw, list) or len(visits_raw) > 200:
        errs["visits"] = "200件以下の配列で指定してください"
        visits_raw = []
    seen_v: set[str] = set()
    for i, v in enumerate(visits_raw):
        p = f"visits[{i}]"
        if not isinstance(v, dict):
            errs[p] = "オブジェクトで指定してください"
            continue
        vid = v.get("visitId")
        if not isinstance(vid, str) or not vid:
            errs[f"{p}.visitId"] = "必須の文字列です"
        elif vid in seen_v:
            errs[f"{p}.visitId"] = "visitId が重複しています"
        else:
            seen_v.add(vid)
        pt = v.get("point")
        if not _is_int(pt) or not (0 <= pt < n_points):
            errs[f"{p}.point"] = "matrix.points の範囲内の整数で指定してください"
        dur = v.get("durationMinutes")
        if not _is_int(dur) or dur < 1:
            errs[f"{p}.durationMinutes"] = "1以上の整数で指定してください"
        w = v.get("window")
        es = ls = None
        if not isinstance(w, dict):
            errs[f"{p}.window"] = "必須のオブジェクトです"
        else:
            if w.get("kind") not in ("fixed", "window"):
                errs[f"{p}.window.kind"] = "fixed または window を指定してください"
            es, ls = _hhmm(w.get("earliestStart")), _hhmm(w.get("latestStart"))
            if es is None:
                errs[f"{p}.window.earliestStart"] = "HH:MM 形式で指定してください"
            if ls is None:
                errs[f"{p}.window.latestStart"] = "HH:MM 形式で指定してください"
            if es is not None and ls is not None and es > ls:
                errs[f"{p}.window.latestStart"] = "earliestStart 以降の時刻にしてください"
        cur = v.get("currentStaffId")
        if cur is not None and not isinstance(cur, str):
            errs[f"{p}.currentStaffId"] = "文字列で指定してください"
        if mode == "order_only":
            if not isinstance(cur, str) or not cur:
                errs[f"{p}.currentStaffId"] = "order_only では必須です"
            elif cur not in seen:
                errs[f"{p}.currentStaffId"] = "staff に存在しない staffId です"
        rg = v.get("requiredGender")
        if rg is not None and rg not in ("female", "male"):
            errs[f"{p}.requiredGender"] = "female または male を指定してください"
        ng = v.get("ngStaffIds", [])
        if not isinstance(ng, list) or not all(isinstance(x, str) for x in ng):
            errs[f"{p}.ngStaffIds"] = "文字列の配列で指定してください"
            ng = []
        gap = v.get("minGapBeforeMinutes", 0)
        if not _is_int(gap) or gap < 0:
            errs[f"{p}.minGapBeforeMinutes"] = "0以上の整数で指定してください"
            gap = 0
        if not any(k.startswith(p) for k in errs):
            visit_list.append(
                Visit(vid, pt, dur * 60, es, ls, cur, rg, frozenset(ng), gap * 60)
            )

    # --- weights / limits ---
    weights = body.get("weights") or {}
    limits = body.get("limits") or {}
    if not isinstance(weights, dict):
        errs["weights"] = "オブジェクトで指定してください"
        weights = {}
    if not isinstance(limits, dict):
        errs["limits"] = "オブジェクトで指定してください"
        limits = {}
    tw = weights.get("travelSeconds", DEFAULT_TRAVEL_WEIGHT)
    ww = weights.get("waitSeconds", DEFAULT_WAIT_WEIGHT)
    for key, val in (("travelSeconds", tw), ("waitSeconds", ww)):
        if not _is_num(val) or val < 0:
            errs[f"weights.{key}"] = "0以上の数値で指定してください"
    if "softWindowSeconds" in weights and (
        not _is_num(weights["softWindowSeconds"]) or weights["softWindowSeconds"] < 0
    ):
        errs["weights.softWindowSeconds"] = "0以上の数値で指定してください"
    tl = limits.get("timeLimitSeconds", DEFAULT_TIME_LIMIT_SECONDS)
    sl = limits.get("solutionLimit", DEFAULT_SOLUTION_LIMIT)
    if not _is_int(tl) or not (1 <= tl <= 30):
        errs["limits.timeLimitSeconds"] = "1〜30の整数で指定してください"
    if not _is_int(sl) or sl < 1:
        errs["limits.solutionLimit"] = "1以上の整数で指定してください"

    if errs:
        raise InvalidArgument(errs)
    return SolveRequest(
        request_id=request_id,
        mode=mode,
        date=date_s,
        staff=staff_list,
        visits=visit_list,
        seconds=seconds,
        meters=meters,
        travel_weight=float(tw),
        wait_weight=float(ww),
        time_limit_seconds=tl,
        solution_limit=sl,
    )


def _parse_breaks(
    raw: Any, shift_start: int | None, shift_end: int | None, p: str, errs: dict[str, str]
) -> tuple[tuple[int, int], ...]:
    """staff[i].breaks を検証する。省略・空配列は休みなし。違反は errs に足す。"""
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > MAX_BREAKS:
        errs[p] = f"{MAX_BREAKS}件以下の配列で指定してください"
        return ()
    out: list[tuple[int, int]] = []
    for j, b in enumerate(raw):
        q = f"{p}[{j}]"
        if not isinstance(b, dict):
            errs[q] = "start と end を持つオブジェクトで指定してください"
            continue
        bs, be = _hhmm(b.get("start")), _hhmm(b.get("end"))
        if bs is None:
            errs[f"{q}.start"] = "HH:MM 形式で指定してください"
        if be is None:
            errs[f"{q}.end"] = "HH:MM 形式で指定してください"
        if bs is None or be is None:
            continue
        if bs >= be:
            errs[f"{q}.end"] = "start より後の時刻にしてください"
            continue
        if shift_start is not None and shift_end is not None and (
            bs < shift_start or be > shift_end
        ):
            errs[q] = "shiftStart〜shiftEnd の内側にしてください"
            continue
        if out and bs < out[-1][1]:
            errs[f"{q}.start"] = "前の休みの end 以降にしてください（開始の順・重なりなし）"
            continue
        out.append((bs, be))
    return tuple(out)


def _check_square(raw: Any, n: int, *, allow_negative: bool) -> tuple[bool, list[list[int]]]:
    if not isinstance(raw, list) or len(raw) != n:
        return False, []
    for row in raw:
        if not isinstance(row, list) or len(row) != n:
            return False, []
        for x in row:
            if not _is_int(x) or (x < 0 and not (allow_negative and x == -1)):
                return False, []
    return True, raw
