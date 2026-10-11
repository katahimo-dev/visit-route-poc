"""OR-Tools Routing による VRPTW の求解と、解からの経路・時刻の組み立て。

再現性について（ADR-0003, AGENTS.md「optimizer に乱数・時刻依存を入れない」）:
  - 単一スレッド・PATH_CHEAPEST_ARC → GUIDED_LOCAL_SEARCH。乱数は使わない。
  - 探索は `solution_limit`（解の数）と `time_limit` の両方で打ち切る。
    決定的なのは solution_limit で打ち切った場合だけ。time_limit に達して打ち切ると、
    マシンの速さで到達点が変わり結果がぶれうる。そのとき `partial: true` を返す。
  - 出力の時刻は、求解後に経路の順番から前詰めで再計算する（求解器内部の遊びに依存しない）。
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .diagnose import diagnose, eligible_staff
from .request import SolveRequest

DAY = 86400
UNREACHABLE = 1_000_000  # 到達不能の移動時間（時間次元の上限を超えるので通れない）
COST_SCALE = 100  # 重み（小数）を整数コストにする倍率
DROP_PENALTY = 1_000_000_000  # 訪問を落とす罰則。移動・待ちの得よりずっと大きくする


@dataclass
class RawSolution:
    routes: list[list[int]]  # スタッフ添字ごとの訪問添字の並び
    dropped: list[int]
    hit_time_limit: bool


def _travel(req: SolveRequest, a: int, b: int) -> int:
    t = req.seconds[a][b]
    return UNREACHABLE if t < 0 else t


def _forbid_breaks(
    routing: pywrapcp.RoutingModel,
    time_dim: pywrapcp.RoutingDimension,
    index: int,
    duration: int,
    req: SolveRequest,
    allowed: list[int],
) -> None:
    """担当スタッフの休みに、この訪問の作業 [開始, 開始+所要) が重ならないようにする（ADR-0008）。

    制約は「スタッフ k が担当する ⇒ 開始 ∉ (休み開始 − 所要, 休み終了)」。移動・待ちは縛らない。
    OR-Tools 標準の SetBreakIntervalsOfVehicle は休み中の移動を許さない（休みの長さぶん
    遊びが要る）ため使わず、担当と開始時刻の組に対する制約として直接書く。
    """
    solver = routing.solver()
    cumul = time_dim.CumulVar(index)
    vehicle = routing.VehicleVar(index)
    for k in allowed:
        for bs, be in req.staff[k].breaks:
            lo, hi = bs - duration + 1, be - 1  # 重なる開始時刻の範囲（両端を含む）
            if hi < lo:
                continue
            if len(allowed) == 1:
                cumul.RemoveInterval(lo, hi)  # 担当が1人に決まっている（順番だけのモードなど）
                continue
            on_k = solver.IsEqualCstVar(vehicle, k)
            overlaps = solver.IsBetweenVar(cumul, lo, hi)
            solver.Add(on_k + overlaps <= 1)


def _solve_model(req: SolveRequest) -> RawSolution:
    n_v = len(req.visits)
    n_s = len(req.staff)
    # ノード: 0..n_v-1 が訪問、以降はスタッフごとに (出発, 帰宅) の2つ
    node_point = [v.point for v in req.visits]
    starts, ends = [], []
    for i, s in enumerate(req.staff):
        starts.append(n_v + 2 * i)
        ends.append(n_v + 2 * i + 1)
        node_point.append(s.start_point)
        node_point.append(s.end_point)

    manager = pywrapcp.RoutingIndexManager(len(node_point), n_s, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    def is_visit(node: int) -> bool:
        return node < n_v

    def is_end(node: int) -> bool:
        return node >= n_v and (node - n_v) % 2 == 1

    def time_cb(from_index: int, to_index: int) -> int:
        a, b = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
        if not is_visit(a) and is_end(b):
            return 0  # 訪問ゼロの経路（出発→帰宅）は制約にしない
        t = _travel(req, node_point[a], node_point[b])
        if is_visit(a):
            t += req.visits[a].duration_seconds
            if is_visit(b):
                t += req.visits[b].min_gap_seconds  # 前の訪問との余裕
        return t

    def cost_cb(from_index: int, to_index: int) -> int:
        a, b = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
        if not is_visit(a) and is_end(b):
            return 0
        t = _travel(req, node_point[a], node_point[b])
        return round(t * req.travel_weight * COST_SCALE)

    time_idx = routing.RegisterTransitCallback(time_cb)
    cost_idx = routing.RegisterTransitCallback(cost_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(cost_idx)

    routing.AddDimension(time_idx, DAY, 2 * DAY, False, "time")
    time_dim = routing.GetDimensionOrDie("time")
    time_dim.SetSlackCostCoefficientForAllVehicles(round(req.wait_weight * COST_SCALE))

    for i, s in enumerate(req.staff):
        time_dim.CumulVar(routing.Start(i)).SetRange(s.shift_start, s.shift_end)
        time_dim.CumulVar(routing.End(i)).SetRange(s.shift_start, s.shift_end)

    # 最大訪問数（件数次元）
    def count_cb(from_index: int) -> int:
        return 1 if is_visit(manager.IndexToNode(from_index)) else 0

    count_idx = routing.RegisterUnaryTransitCallback(count_cb)
    caps = [s.max_visits if s.max_visits is not None else n_v for s in req.staff]
    routing.AddDimensionWithVehicleCapacity(count_idx, 0, caps, True, "count")

    # 訪問ごとの時間枠・担当可否・落とす選択肢
    for vi, v in enumerate(req.visits):
        index = manager.NodeToIndex(vi)
        time_dim.CumulVar(index).SetRange(v.earliest_start, v.latest_start)
        ok_ids = {s.staff_id for s in eligible_staff(req, v)}
        allowed = [i for i, s in enumerate(req.staff) if s.staff_id in ok_ids]
        routing.VehicleVar(index).SetValues([-1, *allowed])
        routing.AddDisjunction([index], DROP_PENALTY)
        _forbid_breaks(routing, time_dim, index, v.duration_seconds, req, allowed)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    params.solution_limit = req.solution_limit
    params.time_limit.seconds = req.time_limit_seconds

    found = [0]

    def on_solution() -> None:
        found[0] += 1

    routing.AddAtSolutionCallback(on_solution)
    assignment = routing.SolveWithParameters(params)
    if assignment is None:
        # 全訪問を落とす解は常に存在するので通常は来ない。来たら全件未割当で返す
        return RawSolution([[] for _ in range(n_s)], list(range(n_v)), False)

    routes: list[list[int]] = []
    for vh in range(n_s):
        idx = routing.Start(vh)
        seq = []
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if is_visit(node):
                seq.append(node)
            idx = assignment.Value(routing.NextVar(idx))
        routes.append(seq)
    assigned = {n for r in routes for n in r}
    dropped = [i for i in range(n_v) if i not in assigned]
    # GUIDED_LOCAL_SEARCH は自分では終わらないので、解の数の上限に届かず止まった＝時間切れ
    # （この版の OR-Tools は時間切れでも status が SUCCESS になるため、解の数で判定する）
    timed_out = found[0] < req.solution_limit
    return RawSolution(routes, dropped, timed_out)


def unassigned_with_reasons(req: SolveRequest, dropped: list[int]) -> list[dict]:
    return [
        {"visitId": req.visits[i].visit_id, "reasons": diagnose(req, req.visits[i])}
        for i in dropped
    ]


def solve_routing(req: SolveRequest) -> RawSolution:
    """単独でも入らない訪問（性別・NG・到達不能・勤務時間外）は求解せず先に落とす。

    落とす訪問を残すと、探索が解の数の上限に届かず時間切れまで走ることがあるため。
    診断は求解の落選理由と同じ関数なので、原因は変わらない。
    """
    active = [i for i, v in enumerate(req.visits) if diagnose(req, v) == ["time_window"]]
    pre_dropped = [i for i in range(len(req.visits)) if i not in set(active)]
    if not active:
        return RawSolution([[] for _ in req.staff], pre_dropped, False)
    sub = replace(req, visits=[req.visits[i] for i in active])
    raw = _solve_model(sub)
    routes = [[active[k] for k in r] for r in raw.routes]
    dropped = sorted(pre_dropped + [active[k] for k in raw.dropped])
    return RawSolution(routes, dropped, raw.hit_time_limit)
