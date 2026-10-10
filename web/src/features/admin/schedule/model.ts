import { type Client, hhmmToMinutes, minutesToHhmm, type Staff, type Visit, weekday } from '@vrp/shared';

/** 予定画面の手作業案（スタッフ列への割り当てと順番）の組み立て。画面と Firebase に依存しない */

export const NONE = '__none';
export type Cols = Record<string, string[]>;
export type View = { cols: Cols; unassigned: string[] };
type V = Visit & { id: string };

/** 保存済み/編集中の並びと、いまある訪問を突き合わせる（消えた訪問を除き、新しい訪問は担当の列か未割当へ） */
export function reconcile(base: Cols, visits: V[], staffIds: string[]): View {
  const alive = new Set(visits.map((v) => v.id));
  const placed = new Set<string>();
  const unassigned: string[] = [];
  for (const id of base[NONE] ?? []) {
    if (alive.has(id) && !placed.has(id)) {
      unassigned.push(id);
      placed.add(id);
    }
  }
  const cols: Cols = {};
  for (const s of staffIds) {
    cols[s] = (base[s] ?? []).filter((id) => alive.has(id) && !placed.has(id));
    for (const id of cols[s]) placed.add(id);
  }
  const byId = new Map(visits.map((x) => [x.id, x]));
  const rest = visits.filter((v) => !placed.has(v.id)).sort(byStart);
  for (const v of rest) {
    const col = v.staffId ? cols[v.staffId] : undefined;
    if (col) insertByTime(col, v, byId);
    else unassigned.push(v.id);
  }
  return { cols, unassigned };
}

const byStart = (a: Visit, b: Visit) =>
  a.earliestStart.localeCompare(b.earliestStart) || a.latestStart.localeCompare(b.latestStart);

/** 開始時刻が同じか早い訪問のうち、いちばん後ろのものの次に入れる（手で並べ替えた列の順番は崩さない） */
function insertByTime(col: string[], v: Visit & { id: string }, byId: Map<string, Visit>): void {
  const at = col.findLastIndex((id) => {
    const x = byId.get(id);
    return x ? byStart(x, v) <= 0 : false;
  });
  col.splice(at + 1, 0, v.id);
}

/** 担当を変える（to は staffId か NONE）。移した先の列では開始時刻の順の位置に入れる */
export function assign(view: View, id: string, to: string, visitById: Map<string, V>): View {
  const cols: Cols = {};
  for (const [k, ids] of Object.entries(view.cols)) cols[k] = ids.filter((x) => x !== id);
  const unassigned = view.unassigned.filter((x) => x !== id);
  const v = visitById.get(id);
  if (to === NONE || !v) {
    unassigned.push(id);
  } else {
    cols[to] = cols[to] ?? [];
    insertByTime(cols[to], v, visitById);
  }
  return { cols, unassigned };
}

/** 列の中で1つ上（-1）・下（+1）へ */
export function shift(view: View, staffId: string, index: number, dir: -1 | 1): View {
  const ids = [...(view.cols[staffId] ?? [])];
  const j = index + dir;
  if (j < 0 || j >= ids.length) return view;
  [ids[index], ids[j]] = [ids[j] as string, ids[index] as string];
  return { ...view, cols: { ...view.cols, [staffId]: ids } };
}

/** 列を開始時刻の順に並べ直す */
export function sortByTime(view: View, staffId: string, visitById: Map<string, Visit>): View {
  const ids = [...(view.cols[staffId] ?? [])].sort((a, b) => {
    const x = visitById.get(a);
    const y = visitById.get(b);
    return x && y ? byStart(x, y) : 0;
  });
  return { ...view, cols: { ...view.cols, [staffId]: ids } };
}

export function isTimeOrdered(ids: string[], visitById: Map<string, Visit>): boolean {
  return ids.every((id, i) => {
    const prev = i > 0 ? visitById.get(ids[i - 1] as string) : undefined;
    const cur = visitById.get(id);
    return !prev || !cur || byStart(prev, cur) <= 0;
  });
}

/** 列の中の訪問の目安の時刻（移動時間は入れない）。開始が約束より遅れるなら late */
export type Slot = { start: string; end: string; late: boolean };
export function slotsOf(ids: string[], visitById: Map<string, Visit>): Map<string, Slot> {
  const out = new Map<string, Slot>();
  let free = 0;
  for (const id of ids) {
    const v = visitById.get(id);
    if (!v) continue;
    const start = Math.max(hhmmToMinutes(v.earliestStart), free);
    const end = start + v.durationMinutes;
    out.set(id, { start: minutesToHhmm(start), end: minutesToHhmm(end), late: start > hhmmToMinutes(v.latestStart) });
    free = end;
  }
  return out;
}

/** 担当の割り当てで気をつけること（画面に出す印。保存は止めない） */
export type Warning = 'off_day' | 'gender' | 'ng' | 'late';
export const WARNING_LABELS: Record<Warning, string> = {
  off_day: '勤務日ではない',
  gender: '性別の希望',
  ng: 'NGの組み合わせ',
  late: '時間に間に合わない',
};

export function warningsOf(
  date: string,
  staff: Staff | undefined,
  staffId: string | null,
  client: Client | undefined,
  ngStaffIds: string[],
  slot: Slot | undefined,
): Warning[] {
  if (!staff || !staffId) return [];
  const w: Warning[] = [];
  if (!staff.workDays.includes(weekday(date))) w.push('off_day');
  if (client?.requiredGender && staff.gender !== client.requiredGender) w.push('gender');
  if (ngStaffIds.includes(staffId)) w.push('ng');
  if (slot?.late) w.push('late');
  return w;
}

/** 訪問の時間の表示（幅があれば「10:30〜11:30に開始」） */
export function windowText(v: Visit): string {
  return v.windowKind === 'window' ? `${v.earliestStart}〜${v.latestStart}` : v.earliestStart;
}
