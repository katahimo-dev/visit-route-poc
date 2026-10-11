import { type Client, hhmmToMinutes, minutesToHhmm, type Slot, type Staff, type Visit, withinSlots } from '@vrp/shared';

/**
 * 予定画面の手作業案（担当ごとの訪問の割当）の組み立て。画面と Firebase に依存しない。
 * 回る順番は開始時刻の順で、手では並べ替えない（PRD R3）
 */

export const NONE = '__none';
export type Cols = Record<string, string[]>;
export type View = { cols: Cols; unassigned: string[] };
type V = Visit & { id: string };

const byStart = (a: Visit, b: Visit) =>
  a.earliestStart.localeCompare(b.earliestStart) || a.latestStart.localeCompare(b.latestStart);

/** 訪問IDの列を開始時刻の順に並べる */
export function timeOrder(ids: string[], visitById: Map<string, Visit>): string[] {
  return [...ids].sort((a, b) => {
    const x = visitById.get(a);
    const y = visitById.get(b);
    return x && y ? byStart(x, y) : 0;
  });
}

/** 保存済み/編集中の割当と、いまある訪問を突き合わせる（消えた訪問を除き、新しい訪問は担当の列か未割当へ） */
export function reconcile(base: Cols, visits: V[], staffIds: string[]): View {
  const byId = new Map(visits.map((v) => [v.id, v]));
  const placed = new Set<string>();
  const unassigned: string[] = [];
  for (const id of base[NONE] ?? []) {
    if (byId.has(id) && !placed.has(id)) {
      unassigned.push(id);
      placed.add(id);
    }
  }
  const cols: Cols = {};
  for (const s of staffIds) {
    cols[s] = (base[s] ?? []).filter((id) => byId.has(id) && !placed.has(id));
    for (const id of cols[s]) placed.add(id);
  }
  for (const v of visits) {
    if (placed.has(v.id)) continue;
    const col = v.staffId ? cols[v.staffId] : undefined;
    if (col) col.push(v.id);
    else unassigned.push(v.id);
  }
  for (const s of staffIds) cols[s] = timeOrder(cols[s] ?? [], byId);
  return { cols, unassigned: timeOrder(unassigned, byId) };
}

/** 担当を変える（to は staffId か NONE）。移した先でも開始時刻の順 */
export function assign(view: View, id: string, to: string, visitById: Map<string, V>): View {
  const cols: Cols = {};
  for (const [k, ids] of Object.entries(view.cols)) cols[k] = ids.filter((x) => x !== id);
  const unassigned = view.unassigned.filter((x) => x !== id);
  if (to === NONE || !visitById.has(id)) return { cols, unassigned: timeOrder([...unassigned, id], visitById) };
  cols[to] = timeOrder([...(cols[to] ?? []), id], visitById);
  return { cols, unassigned };
}

/**
 * 列の中の訪問の時刻（移動時間は入れない目安）と、時間の重なり。
 * 前の訪問が終わるまで次は始められないとして詰め、約束の時刻（幅があれば最も遅い開始）を過ぎる訪問と、
 * その原因になった前の訪問の両方を「重なり」にする
 */
export type Slotted = { start: number; end: number; overlap: boolean };
export function timesOf(ids: string[], visitById: Map<string, Visit>): Map<string, Slotted> {
  const out = new Map<string, Slotted>();
  let free = 0;
  let prevId: string | null = null;
  for (const id of ids) {
    const v = visitById.get(id);
    if (!v) continue;
    const start = Math.max(hhmmToMinutes(v.earliestStart), free);
    const end = start + v.durationMinutes;
    const overlap = start > hhmmToMinutes(v.latestStart);
    out.set(id, { start, end, overlap });
    const prev = prevId ? out.get(prevId) : undefined;
    if (overlap && prev) prev.overlap = true;
    free = end;
    prevId = id;
  }
  return out;
}

export const hhmm = (minutes: number) => minutesToHhmm(minutes);

/** 担当の割当で気をつけること。赤い枠になるのは overlap と outside（保存は止めない） */
export type Warning = 'overlap' | 'outside' | 'gender' | 'ng';
export const WARNING_LABELS: Record<Warning, string> = {
  overlap: '時間が重なる',
  outside: '稼働時間外',
  gender: '性別の希望',
  ng: 'NGの組み合わせ',
};
export const isRed = (w: Warning[]) => w.includes('overlap') || w.includes('outside');

export function warningsOf(
  staff: Staff | undefined,
  staffId: string | null,
  slots: Slot[],
  client: Client | undefined,
  ngStaffIds: string[],
  time: Slotted | undefined,
): Warning[] {
  if (!staff || !staffId) return [];
  const w: Warning[] = [];
  if (time?.overlap) w.push('overlap');
  if (time && !withinSlots(slots, time.start, time.end)) w.push('outside');
  if (client?.requiredGender && staff.gender !== client.requiredGender) w.push('gender');
  if (ngStaffIds.includes(staffId)) w.push('ng');
  return w;
}

/** 訪問の時間の表示（幅があれば「10:30〜11:30」に開始） */
export function windowText(v: Visit): string {
  return v.windowKind === 'window' ? `${v.earliestStart}〜${v.latestStart}` : v.earliestStart;
}
