import {
  availabilityOf,
  type Client,
  type ClientPrivate,
  type EvalMatrix,
  type EvalStaff,
  type EvalVisit,
  type Org,
  type PlanParams,
  type Slot,
  type SolveRequest,
  type Staff,
  shiftOf,
  type Visit,
} from '@vrp/shared';

/**
 * その日の訪問・スタッフから、最適化の入力と、計画値比較に使う評価用データを作る（純粋関数）。
 * 位置が無いスタッフ・訪問先は除外し、除外した理由を返す（画面で知らせる）。
 */

export type Entities = {
  org: Org;
  staff: (Staff & { id: string })[];
  /** 訪問先と、管理者だけの情報（NG スタッフ）を合わせたもの */
  clients: Map<string, Client & ClientPrivate>;
  visits: (Visit & { id: string })[];
  /** 手作業案（スタッフ → 訪問IDの順番） */
  manualRoutes: Record<string, string[]>;
  /** その日の稼働時間帯の上書き（staffId → 時間帯。ADR-0008）。無いスタッフは基本の曜日と時間 */
  availability: Map<string, { slots: Slot[] }>;
  /** AI案のパラメータのうち、最適化の制約になるもの（ADR-0009）。省略は制約なし */
  params?: Pick<PlanParams, 'minGapMinutes' | 'maxVisitsPerStaff'>;
};

export type Prepared = {
  points: { id: string; lat: number; lng: number }[];
  staffIn: EvalStaff[];
  visitsIn: Record<string, EvalVisit>;
  skipped: { kind: 'staff' | 'visit'; id: string; reason: 'no_location' | 'not_working' | 'inactive' }[];
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

  const maxVisits = e.params?.maxVisitsPerStaff ?? null;
  const minGap = e.params?.minGapMinutes ?? 0;
  const staffIn: EvalStaff[] = [];
  const staffReq: SolveRequest['staff'] = [];
  for (const s of e.staff) {
    if (!s.active) {
      // 休止中の人に手作業の担当が残っていれば知らせる（計算には入れない）
      if (assigned.has(s.id)) skipped.push({ kind: 'staff', id: s.id, reason: 'inactive' });
      continue;
    }
    // その日に稼働時間帯があるか、手作業案で担当があるスタッフだけを対象にする。
    // 時間帯の無い日（休み）に担当がある人は、手作業案を評価するために基本の時間で入れるが、
    // 最適化では訪問を持たせず（maxVisits 0）、評価では担当1件ごとに条件違反にする
    const shift = shiftOf(availabilityOf(s, date, e.availability.get(s.id)).slots);
    if (!shift && !assigned.has(s.id)) continue;
    const { shiftStart, shiftEnd, breaks } = shift ?? { shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, breaks: [] };
    if (s.home.lat === null || s.home.lng === null) {
      skipped.push({ kind: 'staff', id: s.id, reason: 'no_location' });
      continue;
    }
    const p = add(`staff/${s.id}`, s.home.lat, s.home.lng);
    staffIn.push({
      staffId: s.id,
      homePointId: `staff/${s.id}`,
      shiftStart,
      shiftEnd,
      breaks,
      ...(shift ? {} : { off: true }),
    });
    staffReq.push({
      staffId: s.id,
      gender: s.gender,
      startPoint: p,
      endPoint: p,
      shiftStart,
      shiftEnd,
      ...(breaks.length > 0 ? { breaks } : {}),
      ...(!shift ? { maxVisits: 0 } : maxVisits !== null ? { maxVisits } : {}),
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
      ...(minGap > 0 ? { minGapBeforeMinutes: minGap } : {}),
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
