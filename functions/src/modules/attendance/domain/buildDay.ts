import {
  type AttendanceDay,
  type AttendanceVisit,
  hhmmToMinutes,
  jstToMs,
  minutesToHhmm,
  type VisitEvent,
} from '@vrp/shared';

/**
 * スタッフの記録（イベント）から1日の勤怠候補を作る（自動確定はしない）。
 * - 到着：最初の arrive。無ければ「はじめる」時刻で補い arriveFilled を立てる
 * - 実働：はじめる〜おわる の合計
 * - 移動：前の訪問の退出（無ければおわる）→ 次の訪問の到着 の合計（自宅との往復は含めない）
 * - 拘束：最初の到着 → 最後の退出（無ければおわる）
 * - 休憩：拘束 − 実働 − 移動（訪問先での待ちも含む）
 * 定義は PRD §8「休憩の定義」が決まるまでの仮。
 */

export type PlannedVisit = { visitId: string; earliestStart: string; durationMinutes: number };

const CHANGED_THRESHOLD_MIN = 15;

function pick(events: VisitEvent[], type: VisitEvent['type'], which: 'first' | 'last'): number | null {
  const ts = events.filter((e) => e.type === type).map((e) => e.clientTime);
  if (ts.length === 0) return null;
  return which === 'first' ? Math.min(...ts) : Math.max(...ts);
}

export function buildAttendanceDay(
  staffId: string,
  date: string,
  planned: PlannedVisit[],
  events: VisitEvent[],
  previous: AttendanceDay | null,
): AttendanceDay {
  const prevById = new Map((previous?.visits ?? []).map((v) => [v.visitId, v]));
  const visits: AttendanceVisit[] = planned.map((p) => {
    const evs = events.filter((e) => e.visitId === p.visitId);
    const start = pick(evs, 'service_start', 'first');
    const end = pick(evs, 'service_end', 'last');
    let arrive = pick(evs, 'arrive', 'first');
    let arriveFilled = false;
    if (start !== null && (arrive === null || arrive > start)) {
      arrive = start;
      arriveFilled = true;
    }
    const departs = evs.filter((e) => e.type === 'depart' && (end === null || e.clientTime >= end));
    const depart = departs.length ? Math.max(...departs.map((e) => e.clientTime)) : null;
    const prev = prevById.get(p.visitId);
    const plannedStart = p.earliestStart;
    const plannedEnd = minutesToHhmm(hhmmToMinutes(p.earliestStart) + p.durationMinutes);
    const v: AttendanceVisit = {
      visitId: p.visitId,
      planned: { start: plannedStart, end: plannedEnd },
      arrive,
      start,
      end,
      depart,
      arriveFilled,
      corrections: prev?.corrections ?? {},
      correctionNote: prev?.correctionNote ?? '',
      changed: false,
    };
    v.changed = isChanged(date, v);
    return v;
  });

  const shiftStart = pick(events, 'shift_start', 'first');
  const shiftEnd = pick(events, 'shift_end', 'last');
  return {
    staffId,
    date,
    shiftStart,
    shiftEnd,
    visits,
    totals: computeTotals(visits),
    status: previous?.status === 'approved' ? 'approved' : 'candidate',
    version: (previous?.version ?? 0) + 1,
    approvedBy: previous?.approvedBy ?? null,
  };
}

/** 訂正を反映した値 */
export function effective(v: AttendanceVisit, field: 'arrive' | 'start' | 'end' | 'depart'): number | null {
  return v.corrections[field] ?? v[field];
}

function isChanged(date: string, v: AttendanceVisit): boolean {
  const s = effective(v, 'start');
  const e = effective(v, 'end');
  if (s === null || e === null) return false;
  const ps = jstToMs(date, v.planned.start);
  const pe = jstToMs(date, v.planned.end);
  const th = CHANGED_THRESHOLD_MIN * 60000;
  return Math.abs(s - ps) >= th || Math.abs(e - pe) >= th;
}

export function computeTotals(visits: AttendanceVisit[]): AttendanceDay['totals'] {
  const done = visits
    .map((v) => ({
      arrive: effective(v, 'arrive'),
      start: effective(v, 'start'),
      end: effective(v, 'end'),
      depart: effective(v, 'depart'),
    }))
    .filter(
      (v): v is { arrive: number; start: number; end: number; depart: number | null } =>
        v.arrive !== null && v.start !== null && v.end !== null && v.end >= v.start,
    )
    .sort((a, b) => a.start - b.start);
  const min = (ms: number) => Math.max(0, Math.round(ms / 60000));
  let work = 0;
  let travel = 0;
  for (let i = 0; i < done.length; i++) {
    const v = done[i]!;
    work += v.end - v.start;
    const prev = done[i - 1];
    if (prev) travel += Math.max(0, v.arrive - (prev.depart ?? prev.end));
  }
  if (done.length === 0) return { workMinutes: 0, travelMinutes: 0, breakMinutes: 0, boundMinutes: 0 };
  const first = done[0]!;
  const last = done[done.length - 1]!;
  const bound = (last.depart ?? last.end) - first.arrive;
  return {
    workMinutes: min(work),
    travelMinutes: min(travel),
    breakMinutes: min(bound - work - travel),
    boundMinutes: min(bound),
  };
}

/** 版（version）以外の中身が同じか。同じなら書き直さない */
export function sameDay(a: AttendanceDay, b: AttendanceDay): boolean {
  const { version: _va, ...ra } = a;
  const { version: _vb, ...rb } = b;
  return canonical(ra) === canonical(rb);
}

/** キーの順番によらない文字列（Firestore から読んだ文書はキーの順番が変わる） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
