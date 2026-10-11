import { hhmmToMinutes } from './time';

/**
 * 決まった順番の1日のルートを、移動時間行列で時刻計算する（計画値）。
 * 手作業案とAI案を「同じ行列」で比べるために使う（PRD §5 計画値比較）。
 */

export type EvalMatrix = {
  /** 地点ID（staff/{id}・clients/{id}）→ 行列の添字 */
  index: Record<string, number>;
  seconds: number[][];
  meters: number[][];
};

export type EvalVisit = {
  visitId: string;
  pointId: string;
  earliestStart: string;
  latestStart: string;
  durationMinutes: number;
};

export type EvalStaff = {
  staffId: string;
  homePointId: string;
  shiftStart: string;
  shiftEnd: string;
  /** 勤務時間の中の休み（ADR-0008）。作業は休み明けまで待って始める */
  breaks?: { start: string; end: string }[];
  /** その日は休み（稼働時間帯なし）なのに手作業案で担当がある。訪問1件ごとに条件違反 */
  off?: boolean;
};

export type StopTiming = {
  visitId: string;
  /** すべて 0時からの分 */
  arrival: number;
  start: number;
  end: number;
  waitMinutes: number;
  travelMinutes: number;
  late: boolean;
};

export type RouteMetrics = {
  travelSeconds: number;
  meters: number;
  waitSeconds: number;
  /** 時間の約束に遅れる・勤務時間を超える・休みの日の担当・到達不能の件数 */
  violations: number;
  stops: StopTiming[];
};

function leg(m: EvalMatrix, from: string, to: string): { sec: number; meters: number } | null {
  const i = m.index[from];
  const j = m.index[to];
  if (i === undefined || j === undefined) return null;
  const sec = m.seconds[i]?.[j];
  if (sec === undefined || sec < 0) return null;
  return { sec, meters: m.meters[i]?.[j] ?? 0 };
}

/**
 * 作業 [start, start+dur) が休みにかかるなら、休み明けまで開始を遅らせる（最適化サービスの avoid_breaks と同じ規則）。
 * 戻り値は開始と、そのうち休みで待った分
 */
function avoidBreaks(
  start: number,
  dur: number,
  breaks: { start: string; end: string }[],
): { start: number; rest: number } {
  let s = start;
  let rest = 0;
  for (const b of breaks) {
    const bs = hhmmToMinutes(b.start);
    const be = hhmmToMinutes(b.end);
    if (s < be && bs < s + dur) {
      rest += be - Math.max(s, bs);
      s = be;
    }
  }
  return { start: s, rest };
}

export function evaluateRoute(staff: EvalStaff, visits: EvalVisit[], m: EvalMatrix): RouteMetrics {
  let t = hhmmToMinutes(staff.shiftStart);
  let at = staff.homePointId;
  let travelSeconds = 0;
  let meters = 0;
  let waitSeconds = 0;
  let violations = 0;
  const stops: StopTiming[] = [];
  // 自宅は最初の訪問に間に合うように出る（出発時刻を勤務開始に縛らない）
  let first = true;
  for (const v of visits) {
    const l = leg(m, at, v.pointId);
    if (!l) {
      violations++;
      continue;
    }
    const travelMinutes = l.sec / 60;
    const earliest = hhmmToMinutes(v.earliestStart);
    const latest = hhmmToMinutes(v.latestStart);
    if (first) t = Math.max(t, earliest - travelMinutes);
    first = false;
    const arrival = t + travelMinutes;
    const shifted = avoidBreaks(Math.max(arrival, earliest), v.durationMinutes, staff.breaks ?? []);
    const start = shifted.start;
    // 休みの時間は待ちに数えない
    const wait = start - arrival - shifted.rest;
    const late = start > latest + 0.01;
    if (late) violations++;
    if (staff.off) violations++;
    const end = start + v.durationMinutes;
    stops.push({ visitId: v.visitId, arrival, start, end, waitMinutes: wait, travelMinutes, late });
    travelSeconds += l.sec;
    meters += l.meters;
    waitSeconds += wait * 60;
    t = end;
    at = v.pointId;
  }
  if (visits.length > 0) {
    const back = leg(m, at, staff.homePointId);
    if (back) {
      travelSeconds += back.sec;
      meters += back.meters;
      if (t + back.sec / 60 > hhmmToMinutes(staff.shiftEnd) + 0.01) violations++;
    } else {
      violations++;
    }
  }
  return { travelSeconds, meters, waitSeconds, violations, stops };
}

export type PlanMetrics = {
  travelSeconds: number;
  meters: number;
  waitSeconds: number;
  violations: number;
  fareYen: number;
  perStaff: Record<string, Omit<RouteMetrics, 'stops'> & { visitCount: number }>;
};

/** スタッフ別の順番（routes）全体の指標。fareYenPerKm は事業所の交通費単価 */
export function evaluatePlan(
  routes: Record<string, string[]>,
  staff: EvalStaff[],
  visitsById: Record<string, EvalVisit>,
  m: EvalMatrix,
  fareYenPerKm: number,
): PlanMetrics {
  const out: PlanMetrics = { travelSeconds: 0, meters: 0, waitSeconds: 0, violations: 0, fareYen: 0, perStaff: {} };
  for (const s of staff) {
    const ids = routes[s.staffId] ?? [];
    const vs = ids.map((id) => visitsById[id]).filter((v): v is EvalVisit => v !== undefined);
    const r = evaluateRoute(s, vs, m);
    out.perStaff[s.staffId] = {
      travelSeconds: r.travelSeconds,
      meters: r.meters,
      waitSeconds: r.waitSeconds,
      violations: r.violations,
      visitCount: vs.length,
    };
    out.travelSeconds += r.travelSeconds;
    out.meters += r.meters;
    out.waitSeconds += r.waitSeconds;
    out.violations += r.violations;
  }
  out.fareYen = Math.round((out.meters / 1000) * fareYenPerKm);
  return out;
}

/** 画面に出す1件の訪問（分は 0時から）。estimateMinutes は直線距離の概算での前の区間の移動（比べる値が無ければ null） */
export type StopView = {
  visitId: string;
  start: number;
  end: number;
  travelMinutes: number;
  estimateMinutes: number | null;
  late: boolean;
};
/** 画面に出す1人のルート（手作業案・AI案を同じ形で並べる） */
export type RouteView = {
  stops: StopView[];
  /** 最後の訪問から自宅まで */
  backMinutes: number;
  backEstimateMinutes: number | null;
  /** 自宅→訪問→自宅の移動の合計 */
  travelMinutes: number;
  estimateTravelMinutes: number | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 手作業案・AI案を、同じ行列で時刻計算した表示用のルート（スタッフ別）。
 * estimate を渡すと、同じ順番を概算の行列で計算した区間の移動も並べる（地図APIとの差を見せる）
 */
export function routeViews(
  routes: Record<string, string[]>,
  staff: EvalStaff[],
  visitsById: Record<string, EvalVisit>,
  m: EvalMatrix,
  estimate: EvalMatrix | null,
): Record<string, RouteView> {
  const out: Record<string, RouteView> = {};
  for (const s of staff) {
    const vs = (routes[s.staffId] ?? []).map((id) => visitsById[id]).filter((v): v is EvalVisit => v !== undefined);
    if (vs.length === 0) continue;
    const r = evaluateRoute(s, vs, m);
    const e = estimate ? evaluateRoute(s, vs, estimate) : null;
    const lastPoint = vs[vs.length - 1]?.pointId ?? s.homePointId;
    const back = leg(m, lastPoint, s.homePointId);
    const backE = estimate ? leg(estimate, lastPoint, s.homePointId) : null;
    out[s.staffId] = {
      stops: r.stops.map((x) => ({
        visitId: x.visitId,
        start: Math.round(x.start),
        end: Math.round(x.end),
        travelMinutes: r1(x.travelMinutes),
        estimateMinutes: e ? r1(e.stops.find((y) => y.visitId === x.visitId)?.travelMinutes ?? 0) : null,
        late: x.late,
      })),
      backMinutes: r1((back?.sec ?? 0) / 60),
      backEstimateMinutes: backE ? r1(backE.sec / 60) : null,
      travelMinutes: r1(r.travelSeconds / 60),
      estimateTravelMinutes: e ? r1(e.travelSeconds / 60) : null,
    };
  }
  return out;
}
