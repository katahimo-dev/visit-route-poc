/** 時刻の変換。業務の日付・時刻はすべて日本時間（Asia/Tokyo, UTC+9 固定）で扱う */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToHhmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** ms → 日本時間の YYYY-MM-DD */
export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ms → 日本時間の HH:mm */
export function jstHhmm(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/** 日本時間の日付＋HH:mm → ms */
export function jstToMs(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00+09:00`);
}

/** 日付の n 日後（YYYY-MM-DD） */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0=日〜6=土 */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
