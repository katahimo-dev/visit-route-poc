"""スタッフの休み（staff[].breaks、ADR-0008）のテスト。

守ること: 訪問の作業 [開始, 開始+所要) は休みに重ならない。移動は休みにかかってよい。
"""

from __future__ import annotations

import copy
import random

import pytest
from helpers import hhmm, line_matrix, mins, request, staff, visit

from solver import InvalidArgument, solve


def with_breaks(d, *pairs):
    d["breaks"] = [{"start": a, "end": b} for a, b in pairs]
    return d


def stops_of(res):
    return {s["visitId"]: s for r in res["routes"] for s in r["stops"]}


def reason_of(res, vid):
    return {u["visitId"]: u["reasons"] for u in res["unassigned"]}[vid]


def _strip(res):
    r = copy.deepcopy(res)
    r["stats"].pop("computeMillis")
    return r


def break_scenario(seed, n_staff=4, n_visits=14):
    """休みをまたぐ候補が多い乱数の入力。移動は分単位（出力の HH:MM と突き合わせるため）。"""
    rng = random.Random(seed)
    pts = [(rng.random() * 10, rng.random() * 10) for _ in range(n_staff + n_visits)]
    n = len(pts)
    seconds = [
        [
            round(((pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2) ** 0.5 * 3) * 60
            for j in range(n)
        ]
        for i in range(n)
    ]
    patterns = [
        [("12:00", "13:00")],
        [("10:30", "11:00"), ("14:00", "15:30")],
        [("11:00", "12:30")],
        [],
    ]
    staff_list = [
        with_breaks(staff(f"s{i}", i), *patterns[i % len(patterns)]) for i in range(n_staff)
    ]
    visits = []
    for k in range(n_visits):
        e = rng.choice([9, 10, 11, 12, 13, 14]) * 60 + rng.choice([0, 30])
        kind = rng.choice(["fixed", "window"])
        late = e if kind == "fixed" else e + rng.choice([60, 120])
        visits.append(
            visit(
                f"v{k}",
                n_staff + k,
                dur=rng.choice([30, 45, 60, 90]),
                window=(hhmm(e * 60), hhmm(late * 60)),
                kind=kind,
            )
        )
    body = request(staff_list, visits, seconds)
    body["limits"] = {"timeLimitSeconds": 20, "solutionLimit": 100}
    return body


# ---------- 未割当の原因 ----------


@pytest.mark.parametrize("at", ["12:30", "11:45", "12:00"])
def test_fixed_visit_only_in_break_is_unassigned_shift(at):
    # 30分の訪問が 12:30（休みの中）・11:45（終わりが休みにかかる）・12:00（休みの開始）
    m = line_matrix([0, 1], speed=60)
    s = with_breaks(staff("a", 0, shift=("09:00", "18:00")), ("12:00", "13:00"))
    res = solve(request([s], [visit("v", 1, dur=30, window=(at, at), kind="fixed")], m))
    assert res["routes"][0]["stops"] == []
    assert reason_of(res, "v") == ["shift"]


def test_visit_ending_at_break_start_is_assigned():
    # 作業の終わりがちょうど休みの開始（11:30〜12:00）なら重ならない
    m = line_matrix([0, 1], speed=60)
    s = with_breaks(staff("a", 0), ("12:00", "13:00"))
    res = solve(request([s], [visit("v", 1, dur=30, window=("11:30", "11:30"), kind="fixed")], m))
    assert res["unassigned"] == []
    assert stops_of(res)["v"]["start"] == "11:30"


def test_break_only_blocks_that_staff():
    # a は休みで入れないが、b なら入る
    m = line_matrix([0, 0, 1], speed=60)
    a = with_breaks(staff("a", 0), ("12:00", "13:00"))
    res = solve(
        request([a, staff("b", 1)], [visit("v", 2, window=("12:30", "12:30"), kind="fixed")], m)
    )
    assert res["unassigned"] == []
    assert [r["staffId"] for r in res["routes"] if r["stops"]] == ["b"]


def test_window_spanning_break_starts_after_break():
    # 枠 11:50〜13:30 の60分の訪問は、休み（12:00〜13:00）の後に始まる
    m = line_matrix([0, 1], speed=60)
    s = with_breaks(staff("a", 0), ("12:00", "13:00"))
    res = solve(request([s], [visit("v", 1, dur=60, window=("11:50", "13:30"))], m))
    st = stops_of(res)["v"]
    assert res["unassigned"] == []
    assert mins(st["start"]) >= mins("13:00")


# ---------- 作業は休みに重ならない（乱数の入力） ----------


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_work_never_overlaps_breaks_random(seed):
    body = break_scenario(seed)
    res = solve(body)
    breaks = {
        s["staffId"]: [(mins(b["start"]), mins(b["end"])) for b in s.get("breaks", [])]
        for s in body["staff"]
    }
    vmap = {v["visitId"]: v for v in body["visits"]}
    pidx = {s["staffId"]: s["startPoint"] for s in body["staff"]}
    sec = body["matrix"]["seconds"]
    assigned = 0
    near_break = 0
    for r in res["routes"]:
        prev_end, prev_pt = None, pidx[r["staffId"]]
        for st in r["stops"]:
            assigned += 1
            v = vmap[st["visitId"]]
            s0, e0 = mins(st["start"]), mins(st["end"])
            assert e0 - s0 == v["durationMinutes"]
            for bs, be in breaks[r["staffId"]]:
                assert e0 <= bs or s0 >= be, (r["staffId"], st, (bs, be))
                if s0 == be or prev_end is not None and prev_end <= bs and s0 >= be:
                    near_break += 1
            w = v["window"]
            assert mins(w["earliestStart"]) <= s0 <= mins(w["latestStart"])
            assert mins("09:00") <= mins(st["arrival"]) <= s0 and e0 <= mins("18:00")
            if prev_end is not None:
                assert mins(st["arrival"]) >= prev_end + sec[prev_pt][v["point"]] // 60
            prev_end, prev_pt = e0, v["point"]
    assert assigned + len(res["unassigned"]) == len(body["visits"])
    assert assigned >= len(body["visits"]) // 2
    assert near_break > 0  # 休みをはさむ経路が実際にできている


# ---------- 移動は休みにかかってよい ----------


def test_travel_during_break_reaches_visit_right_after_break():
    # A: 11:00〜12:00、休み 12:00〜13:00、B: 13:00 固定。A→B の移動20分は休みの中で済ませる
    m = line_matrix([0, 1, 21], speed=60)
    s = with_breaks(staff("a", 0), ("12:00", "13:00"))
    visits = [
        visit("A", 1, dur=60, window=("11:00", "11:00"), kind="fixed"),
        visit("B", 2, dur=30, window=("13:00", "13:00"), kind="fixed"),
    ]
    res = solve(request([s], visits, m))
    assert res["unassigned"] == []
    st = stops_of(res)
    assert st["A"]["end"] == "12:00"
    assert st["B"]["start"] == "13:00"
    assert mins(st["B"]["arrival"]) < mins("13:00")  # 休みの間に着いている
    assert st["B"]["waitMinutes"] == 0  # 休みは待ちに数えない
    assert res["stats"]["totalWaitSeconds"] == 0


def test_first_visit_right_after_break_departs_during_break():
    # 休み 09:00〜10:00（勤務の始まり）、自宅から30分の訪問に 10:00 ちょうどに入る
    m = line_matrix([0, 30], speed=60)
    s = with_breaks(staff("a", 0, shift=("09:00", "18:00")), ("09:00", "10:00"))
    res = solve(request([s], [visit("v", 1, dur=30, window=("10:00", "10:00"), kind="fixed")], m))
    assert res["unassigned"] == []
    st = stops_of(res)["v"]
    assert st["start"] == "10:00" and st["arrival"] == "10:00"


# ---------- 省略・空配列は今までどおり ----------


def test_empty_breaks_same_as_omitted():
    body = break_scenario(9)
    for s in body["staff"]:
        s.pop("breaks", None)
    empty = copy.deepcopy(body)
    for s in empty["staff"]:
        s["breaks"] = []
    assert _strip(solve(body)) == _strip(solve(empty))


# ---------- 入力の検証 ----------


@pytest.mark.parametrize(
    "breaks,field",
    [
        ([("12:00", "13:00"), ("12:30", "14:00")], "staff[0].breaks[1].start"),  # 重なり
        ([("14:00", "15:00"), ("12:00", "13:00")], "staff[0].breaks[1].start"),  # 順序
        ([("08:00", "09:30")], "staff[0].breaks[0]"),  # 勤務の前にはみ出す
        ([("17:30", "18:30")], "staff[0].breaks[0]"),  # 勤務の後にはみ出す
        ([("13:00", "13:00")], "staff[0].breaks[0].end"),  # start = end
        ([("13:00", "12:00")], "staff[0].breaks[0].end"),  # start > end
        ([("9:00", "10:00")], "staff[0].breaks[0].start"),  # 形式
        ([("10:00", "24:00")], "staff[0].breaks[0].end"),  # 形式（存在しない時刻）
        ([(f"{h}:00", f"{h}:30") for h in range(10, 15)], "staff[0].breaks"),  # 5件
    ],
)
def test_invalid_breaks(breaks, field):
    s = with_breaks(staff("a", 0, shift=("09:00", "18:00")), *breaks)
    body = request([s], [visit("v1", 1)], line_matrix([0, 5]))
    with pytest.raises(InvalidArgument) as e:
        solve(body)
    assert field in e.value.fields


@pytest.mark.parametrize("raw", ["12:00-13:00", [["12:00", "13:00"]], [{"start": "12:00"}]])
def test_invalid_breaks_shape(raw):
    s = staff("a", 0)
    s["breaks"] = raw
    body = request([s], [visit("v1", 1)], line_matrix([0, 5]))
    with pytest.raises(InvalidArgument) as e:
        solve(body)
    assert any(k.startswith("staff[0].breaks") for k in e.value.fields)


def test_adjacent_breaks_and_four_items_are_valid():
    s = with_breaks(
        staff("a", 0),
        ("10:00", "10:30"),
        ("10:30", "11:00"),
        ("12:00", "13:00"),
        ("17:00", "18:00"),
    )
    res = solve(request([s], [visit("v1", 1)], line_matrix([0, 5])))
    assert res["unassigned"] == []


# ---------- 再現性 ----------


def test_deterministic_with_breaks():
    body = break_scenario(11, n_staff=4, n_visits=12)
    body["limits"] = {"timeLimitSeconds": 20, "solutionLimit": 150}
    a, b = solve(body), solve(body)
    assert a["partial"] is False  # 解の数で打ち切った（決定的な経路）
    assert _strip(a) == _strip(b)


def test_order_only_respects_breaks():
    # 担当が1人に決まる順番だけのモードでも、作業は休みに重ならない
    m = line_matrix([0, 1, 2], speed=60)
    s = with_breaks(staff("a", 0), ("12:00", "13:00"))
    visits = [
        visit("x", 1, dur=60, window=("11:30", "13:30"), currentStaffId="a"),
        visit("y", 2, dur=60, window=("11:00", "11:00"), kind="fixed", currentStaffId="a"),
    ]
    res = solve(request([s], visits, m, mode="order_only"))
    assert res["unassigned"] == []
    st = stops_of(res)
    assert st["y"]["start"] == "11:00" and st["y"]["end"] == "12:00"
    assert mins(st["x"]["start"]) >= mins("13:00")
