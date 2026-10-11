import { hhmmToMinutes, minutesToHhmm, weekday } from './time';

/**
 * スタッフの稼働時間帯（ADR-0008）。基本の曜日と時間に、日ごとの上書きを重ねる。
 * 「その日に働ける時間帯」を決めるのはこのファイルだけ（画面・予定の警告・AI案で同じものを使う）。
 */

export type Slot = { start: string; end: string };
/** 30分単位 */
export const SLOT_STEP_MINUTES = 30;
/** 1日の時間帯の上限 */
export const MAX_SLOTS = 4;

type WeeklyBase = { workDays: number[]; shiftStart: string; shiftEnd: string };

/** 基本の曜日と時間から、その日の時間帯（勤務日でなければ空） */
export function weeklySlots(base: WeeklyBase, date: string): Slot[] {
  return base.workDays.includes(weekday(date)) ? [{ start: base.shiftStart, end: base.shiftEnd }] : [];
}

/**
 * その日の時間帯。上書き（availability 文書）があればそれ、無ければ基本。
 * override の slots が空なら「その日は休み」
 */
export function availabilityOf(
  base: WeeklyBase,
  date: string,
  override: { slots: Slot[] } | null | undefined,
): { slots: Slot[]; overridden: boolean } {
  return override ? { slots: override.slots, overridden: true } : { slots: weeklySlots(base, date), overridden: false };
}

/** 時間帯が正しいか（30分単位・開始の順・重なりなし・開始＜終了・上限以内）。正しくなければ理由 */
export function slotsError(slots: Slot[]): string | null {
  if (slots.length > MAX_SLOTS) return `時間帯は${MAX_SLOTS}つまでです`;
  let prevEnd = -1;
  for (const s of slots) {
    const a = hhmmToMinutes(s.start);
    const b = hhmmToMinutes(s.end);
    if (a % SLOT_STEP_MINUTES !== 0 || b % SLOT_STEP_MINUTES !== 0) return '時間は30分単位で選んでください';
    if (a >= b) return '終了は開始より後にしてください';
    if (a < prevEnd) return '時間帯が重なっています';
    prevEnd = b;
  }
  return null;
}

/** 開始の順に並べ、くっついた・重なった時間帯をまとめる */
export function normalizeSlots(slots: Slot[]): Slot[] {
  const sorted = [...slots].sort((x, y) => x.start.localeCompare(y.start));
  const out: Slot[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** 分の区間 [start, end) が、どれか1つの時間帯の中に収まるか */
export function withinSlots(slots: Slot[], startMinutes: number, endMinutes: number): boolean {
  return slots.some((s) => hhmmToMinutes(s.start) <= startMinutes && endMinutes <= hhmmToMinutes(s.end));
}

/** 最適化の入力：勤務の始まり・終わりと、あいだの休み。時間帯が無ければ null（その日は働かない） */
export function shiftOf(slots: Slot[]): { shiftStart: string; shiftEnd: string; breaks: Slot[] } | null {
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (!first || !last) return null;
  const breaks: Slot[] = [];
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1] as Slot;
    const cur = slots[i] as Slot;
    if (prev.end < cur.start) breaks.push({ start: prev.end, end: cur.start });
  }
  return { shiftStart: first.start, shiftEnd: last.end, breaks };
}

/** 表示用：「9:00〜18:00」「9:00〜12:00・14:00〜18:00」「休み」 */
export function slotsText(slots: Slot[]): string {
  if (slots.length === 0) return '休み';
  const t = (hhmm: string) => hhmm.replace(/^0(\d)/, '$1');
  return slots.map((s) => `${t(s.start)}〜${t(s.end)}`).join('・');
}

/** 30分刻みの時刻の選択肢（00:00〜23:30） */
export const HALF_HOURS: string[] = Array.from({ length: 48 }, (_, i) => minutesToHhmm(i * SLOT_STEP_MINUTES));
