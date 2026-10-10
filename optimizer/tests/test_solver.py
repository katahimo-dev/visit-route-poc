"""ソルバーの契約・絶対条件・再現性・性能のテスト。"""

from __future__ import annotations

import copy
import time

import pytest
from helpers import line_matrix, mins, random_scenario, request, staff, visit

from solver import SOLVER_VERSION, InvalidArgument, solve

HHMM = r"^\d{2}:\d{2}$"


def routes_by_staff(res):
    return {r["staffId"]: [s["visitId"] for s in r["stops"]] for r in res["routes"]}


def assigned_staff(res):
    return {s["visitId"]: r["staffId"] for r in res["routes"] for s in r["stops"]}


# ---------- 契約の形 ----------


def test_response_shape():
    # 点: 0,1 = スタッフの自宅、2,3 = 訪問先
    m = line_matrix([0, 10, 1, 9], speed=60)
    body = request(
        [staff("a", 0, gender="female"), staff("b", 1, gender="male")],
        [visit("v1", 2), visit("v2", 3, requiredGender="male", ngStaffIds=["a"])],
        m,
    )
    res = solve(body)
    assert set(res) == {"requestId", "routes", "unassigned", "partial", "stats", "solverVersion"}
    assert res["requestId"] == "run-1"
    assert res["solverVersion"] == SOLVER_VERSION == "0.1.0"
    assert isinstance(res["partial"], bool)
    assert {"totalTravelSeconds", "totalWaitSeconds", "computeMillis"} <= set(res["stats"])
    assert "totalMeters" not in res["stats"]  # meters 未指定
    import re

    for r in res["routes"]:
        assert set(r) == {"staffId", "stops"}
        for s in r["stops"]:
            assert set(s) == {"visitId", "arrival", "start", "end", "waitMinutes"}
            for k in ("arrival", "start", "end"):
                assert re.match(HHMM, s[k])
            assert isinstance(s["waitMinutes"], int) and s["waitMinutes"] >= 0
    assert res["unassigned"] == []
    assert assigned_staff(res) == {"v1": "a", "v2": "b"}


def test_total_meters_when_given():
    m = line_matrix([0, 5], speed=60)
    body = request([staff("a", 0)], [visit("v1", 1)], m)
    body["matrix"]["meters"] = [[0, 500], [500, 0]]
    res = solve(body)
    assert res["stats"]["totalMeters"] == 1000
    assert res["stats"]["totalTravelSeconds"] == 600


def test_zero_visits():
    res = solve(request([staff("a", 0)], [], [[0]]))
    assert res["routes"] == [{"staffId": "a", "stops": []}]
    assert res["unassigned"] == []


@pytest.mark.parametrize(
    "mutate,field",
    [
        (lambda b: b.pop("mode"), "mode"),
        (lambda b: b.update(date="2026-13-40"), "date"),
        (lambda b: b["staff"][0].update(startPoint=99), "staff[0].startPoint"),
        (lambda b: b["staff"][0].update(shiftStart="9:00"), "staff[0].shiftStart"),
        (lambda b: b["visits"][0].update(durationMinutes=0), "visits[0].durationMinutes"),
        (
            lambda b: b["visits"][0]["window"].update(latestStart="08:00"),
            "visits[0].window.latestStart",
        ),
        (lambda b: b["matrix"].update(seconds=[[0]]), "matrix.seconds"),
        (lambda b: b["limits"].update(timeLimitSeconds=99), "limits.timeLimitSeconds"),
        (lambda b: b["visits"][0].update(requiredGender="x"), "visits[0].requiredGender"),
    ],
)
def test_invalid_argument_fields(mutate, field):
    body = request([staff("a", 0)], [visit("v1", 1)], line_matrix([0, 5]))
    mutate(body)
    with pytest.raises(InvalidArgument) as e:
        solve(body)
    assert field in e.value.fields


def test_order_only_requires_current_staff():
    body = request([staff("a", 0)], [visit("v1", 1)], line_matrix([0, 5]), mode="order_only")
    with pytest.raises(InvalidArgument) as e:
        solve(body)
    assert "visits[0].currentStaffId" in e.value.fields


# ---------- 絶対条件 ----------


def test_order_only_never_changes_staff():
    # b の自宅のほうが v1,v2 に近いが、割当は a のまま変えない
    m = line_matrix([0, 100, 99, 98, 1], speed=60)
    visits = [
        visit("v1", 2, currentStaffId="a"),
        visit("v2", 3, currentStaffId="a"),
        visit("v3", 4, currentStaffId="b"),
    ]
    body = request([staff("a", 0), staff("b", 1)], visits, m, mode="order_only")
    res = solve(body)
    cur = {v["visitId"]: v["currentStaffId"] for v in visits}
    assert assigned_staff(res) == cur
    assert res["unassigned"] == []


def test_order_only_reorders():
    # 手作業の順番が悪くても（座標が近い順に直る）、順番は求解で決まる
    m = line_matrix([0, 50, 10, 20], speed=60)
    visits = [visit("far", 1, currentStaffId="a"), visit("near", 2, currentStaffId="a"),
              visit("mid", 3, currentStaffId="a")]
    res = solve(request([staff("a", 0)], visits, m, mode="order_only"))
    assert routes_by_staff(res)["a"] == ["near", "mid", "far"]


def test_gender_and_ng_never_violated_random():
    body = random_scenario(n_staff=5, n_visits=15, seed=7)
    rng_visits = body["visits"]
    for k, v in enumerate(rng_visits):
        if k % 3 == 0:
            v["requiredGender"] = "female"
        if k % 4 == 0:
            v["ngStaffIds"] = ["s0", "s1"]
    body["limits"] = {"timeLimitSeconds": 5, "solutionLimit": 100}
    res = solve(body)
    gender = {s["staffId"]: s.get("gender") for s in body["staff"]}
    amap = assigned_staff(res)
    checked = 0
    for v in rng_visits:
        if v["visitId"] not in amap:
            continue
        checked += 1
        sid = amap[v["visitId"]]
        if "requiredGender" in v:
            assert gender[sid] == v["requiredGender"]
        assert sid not in v.get("ngStaffIds", [])
    assert checked > 0


def test_fixed_window_respected_and_shift():
    m = line_matrix([0, 0, 5, 6, 7], speed=60)
    visits = [
        visit("f1", 2, dur=60, window=("10:00", "10:00"), kind="fixed"),
        visit("f2", 3, dur=60, window=("13:30", "13:30"), kind="fixed"),
        visit("w1", 4, dur=30, window=("09:00", "16:00")),
    ]
    shift = ("09:00", "17:00")
    body = request([staff("a", 0, shift=shift), staff("b", 1, shift=shift)], visits, m)
    res = solve(body)
    stops = {s["visitId"]: s for r in res["routes"] for s in r["stops"]}
    assert stops["f1"]["start"] == "10:00" and stops["f1"]["end"] == "11:00"
    assert stops["f2"]["start"] == "13:30"
    for r in res["routes"]:
        for s in r["stops"]:
            assert mins("09:00") <= mins(s["arrival"]) <= mins(s["start"])
            assert mins(s["end"]) <= mins("17:00")
    # 時間の約束（枠）
    for v in visits:
        s = stops[v["visitId"]]
        w = v["window"]
        assert mins(w["earliestStart"]) <= mins(s["start"]) <= mins(w["latestStart"])


def test_wait_is_reported_after_arrival():
    # 到着が枠の開始より早い → 待つ
    m = line_matrix([0, 1, 2], speed=60)
    visits = [visit("v1", 1, dur=30, window=("09:00", "09:00"), kind="fixed"),
              visit("v2", 2, dur=30, window=("11:00", "11:00"), kind="fixed")]
    res = solve(request([staff("a", 0, shift=("08:00", "18:00"))], visits, m))
    s2 = res["routes"][0]["stops"][1]
    assert s2["start"] == "11:00" and s2["waitMinutes"] > 0
    assert res["routes"][0]["stops"][0]["waitMinutes"] == 0


def test_min_gap_before():
    m = line_matrix([0, 1, 1], speed=0)  # 移動0秒
    visits = [visit("v1", 1, dur=30, window=("09:00", "09:00"), kind="fixed"),
              visit("v2", 2, dur=30, window=("09:30", "12:00"), minGapBeforeMinutes=20)]
    res = solve(request([staff("a", 0)], visits, m))
    s2 = {s["visitId"]: s for s in res["routes"][0]["stops"]}["v2"]
    assert mins(s2["start"]) >= mins("09:30") + 20


def test_max_visits():
    m = line_matrix([0, 1, 2, 3], speed=60)
    visits = [visit(f"v{i}", i + 1, dur=20) for i in range(3)]
    res = solve(request([staff("a", 0, max_visits=2)], visits, m))
    assert len(res["routes"][0]["stops"]) == 2
    assert len(res["unassigned"]) == 1


# ---------- 未割当の原因 ----------


def reason_of(res, vid):
    return {u["visitId"]: u["reasons"] for u in res["unassigned"]}[vid]


def test_reason_gender():
    m = line_matrix([0, 1], speed=60)
    res = solve(request([staff("a", 0, gender="female")],
                        [visit("v", 1, requiredGender="male")], m))
    assert reason_of(res, "v") == ["gender"]


def test_reason_ng_staff():
    m = line_matrix([0, 1], speed=60)
    res = solve(request([staff("a", 0)], [visit("v", 1, ngStaffIds=["a"])], m))
    assert reason_of(res, "v") == ["ng_staff"]


def test_reason_unreachable():
    m = [[0, -1], [-1, 0]]
    res = solve(request([staff("a", 0)], [visit("v", 1)], m))
    assert reason_of(res, "v") == ["unreachable"]


def test_reason_shift():
    # 枠は勤務時間外（19:00）
    m = line_matrix([0, 1], speed=60)
    res = solve(request([staff("a", 0, shift=("09:00", "18:00"))],
                        [visit("v", 1, window=("19:00", "19:30"))], m))
    assert reason_of(res, "v") == ["shift"]


def test_reason_time_window():
    # 単独なら入るが、同じ固定時刻の訪問が2件で1人しかいない
    m = line_matrix([0, 1, 1], speed=60)
    visits = [visit("x", 1, window=("10:00", "10:00"), kind="fixed"),
              visit("y", 2, window=("10:00", "10:00"), kind="fixed")]
    res = solve(request([staff("a", 0)], visits, m))
    assert len(res["unassigned"]) == 1
    assert res["unassigned"][0]["reasons"] == ["time_window"]
    assert len(res["routes"][0]["stops"]) == 1


def test_order_only_unassigned_reason_uses_current_staff():
    m = line_matrix([0, 1, 2], speed=60)
    visits = [visit("v", 2, currentStaffId="a", requiredGender="male")]
    res = solve(request([staff("a", 0, gender="female"), staff("b", 1, gender="male")],
                        visits, m, mode="order_only"))
    assert reason_of(res, "v") == ["gender"]


# ---------- 再現性・性能・効果 ----------


def _strip(res):
    r = copy.deepcopy(res)
    r["stats"].pop("computeMillis")
    return r


def test_deterministic():
    body = random_scenario(n_staff=4, n_visits=12, seed=3)
    body["limits"] = {"timeLimitSeconds": 20, "solutionLimit": 150}
    a, b = solve(body), solve(body)
    assert a["partial"] is False  # 解の数で打ち切った（決定的な経路）
    assert _strip(a) == _strip(b)


def test_performance_8_staff_30_visits():
    body = random_scenario(n_staff=8, n_visits=30, seed=42)
    body["limits"] = {"timeLimitSeconds": 20, "solutionLimit": 2000}
    t = time.monotonic()
    res = solve(body)
    assert time.monotonic() - t < 30
    assigned = sum(len(r["stops"]) for r in res["routes"])
    assert assigned + len(res["unassigned"]) == 30


def test_assign_and_order_reduces_travel_vs_bad_manual():
    # 2つのクラスタ（左: 0付近 / 右: 100付近）。手作業案は左右を取り違えた割当
    coords = [0, 100, 1, 2, 3, 101, 102, 103]  # a自宅=0, b自宅=100, 訪問 v0..v5
    m = line_matrix(coords, speed=60)
    left = ["v0", "v1", "v2"]
    visits = []
    for i in range(6):
        vid = f"v{i}"
        bad = "b" if vid in left else "a"  # 悪い割当
        visits.append(visit(vid, 2 + i, dur=20, window=("09:00", "16:00"), currentStaffId=bad))
    staffs = [staff("a", 0), staff("b", 1)]
    manual = solve(request(staffs, visits, m, mode="order_only"))
    ai = solve(request(staffs, visits, m, mode="assign_and_order"))
    assert ai["stats"]["totalTravelSeconds"] < manual["stats"]["totalTravelSeconds"] / 5
    assert manual["unassigned"] == [] and ai["unassigned"] == []
