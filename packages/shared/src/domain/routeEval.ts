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
