import type { Client, EvalMatrix, EvalStaff, EvalVisit, Org, SolveRequest, Staff, Visit } from '@vrp/shared';

/**
 * その日の訪問・スタッフから、最適化の入力と、計画値比較に使う評価用データを作る（純粋関数）。
 * 位置が無いスタッフ・訪問先は除外し、除外した理由を返す（画面で知らせる）。
 */

export type Entities = {
  org: Org;
  staff: (Staff & { id: string })[];
  clients: Map<string, Client>;
  visits: (Visit & { id: string })[];
  /** 手作業案（スタッフ → 訪問IDの順番） */
  manualRoutes: Record<string, string[]>;
  weekday: number;
};

export type Prepared = {
  points: { id: string; lat: number; lng: number }[];
  staffIn: EvalStaff[];
  visitsIn: Record<string, EvalVisit>;
  skipped: { kind: 'staff' | 'visit'; id: string; reason: 'no_location' | 'not_working' }[];
  request: Omit<SolveRequest, 'matrix' | 'requestId'>;
};

export function prepare(e: Entities, date: string): Prepared {
  const points: Prepared['points'] = [];
  const index = new Map<string, number>();
  const add = (id: string, lat: number, lng: number) => {
    if (!index.has(id)) {
      index.set(id, points.length);
      points.push({ id, lat, lng });
    }
    return index.get(id)!;
  };
  const skipped: Prepared['skipped'] = [];
  const assigned = new Set(Object.keys(e.manualRoutes).filter((k) => (e.manualRoutes[k] ?? []).length > 0));
  for (const v of e.visits) if (v.staffId) assigned.add(v.staffId);

  const staffIn: EvalStaff[] = [];
  const staffReq: SolveRequest['staff'] = [];
  for (const s of e.staff) {
    if (!s.active) continue;
    // その曜日の勤務か、手作業案で担当があるスタッフだけを対象にする
    if (!s.workDays.includes(e.weekday) && !assigned.has(s.id)) continue;
    if (s.home.lat === null || s.home.lng === null) {
      skipped.push({ kind: 'staff', id: s.id, reason: 'no_location' });
      continue;
    }
    const p = add(`staff/${s.id}`, s.home.lat, s.home.lng);
    staffIn.push({ staffId: s.id, homePointId: `staff/${s.id}`, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd });
    staffReq.push({
      staffId: s.id,
      gender: s.gender,
      startPoint: p,
      endPoint: p,
      shiftStart: s.shiftStart,
      shiftEnd: s.shiftEnd,
    });
  }
  const staffIds = new Set(staffIn.map((s) => s.staffId));
  const currentOf = new Map<string, string>();
  for (const [sid, ids] of Object.entries(e.manualRoutes)) for (const id of ids) currentOf.set(id, sid);

  const visitsIn: Record<string, EvalVisit> = {};
  const visitReq: SolveRequest['visits'] = [];
  for (const v of e.visits) {
    const c = e.clients.get(v.clientId);
    if (!c || c.place.lat === null || c.place.lng === null) {
      skipped.push({ kind: 'visit', id: v.id, reason: 'no_location' });
      continue;
    }
    const pointId = `clients/${v.clientId}`;
    const p = add(pointId, c.place.lat, c.place.lng);
    visitsIn[v.id] = {
      visitId: v.id,
      pointId,
      earliestStart: v.earliestStart,
      latestStart: v.windowKind === 'fixed' ? v.earliestStart : v.latestStart,
      durationMinutes: v.durationMinutes,
    };
    const current = currentOf.get(v.id) ?? v.staffId ?? undefined;
    visitReq.push({
      visitId: v.id,
      point: p,
      durationMinutes: v.durationMinutes,
      window: {
        kind: v.windowKind,
        earliestStart: v.earliestStart,
        latestStart: v.windowKind === 'fixed' ? v.earliestStart : v.latestStart,
      },
      ...(current && staffIds.has(current) ? { currentStaffId: current } : {}),
      ...(c.requiredGender ? { requiredGender: c.requiredGender } : {}),
      ...(c.ngStaffIds.length ? { ngStaffIds: c.ngStaffIds } : {}),
    });
  }
  return {
    points,
    staffIn,
    visitsIn,
    skipped,
    request: { mode: e.org.optimizeMode, date, staff: staffReq, visits: visitReq },
  };
}

export function toEvalMatrix(points: { id: string }[], seconds: number[][], meters: number[][]): EvalMatrix {
  return { index: Object.fromEntries(points.map((p, i) => [p.id, i])), seconds, meters };
}
