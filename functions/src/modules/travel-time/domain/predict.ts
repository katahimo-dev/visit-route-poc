import { estimateLeg, type TravelMode } from '@vrp/shared';

/**
 * 移動時間予測AI（α）：地図APIの基準時間 × 補正係数。
 * 補正係数は「移動手段 × 時間帯 × 平日/休日」ごとの倍率で、実測区間から学習して版を上げる（改）。
 * 地図APIが使えない環境（開発・エミュレーター）では直線距離から概算する。
 */

export type TimeBand = 'morning' | 'day' | 'evening';
export type DayType = 'weekday' | 'weekend';

export type TravelModel = {
  version: string;
  /** キー `${mode}:${band}:${dayType}` → 倍率。無いキーは 1.0 */
  factors: Record<string, number>;
};

export const IDENTITY_MODEL: TravelModel = { version: 'v0-identity', factors: {} };

export function timeBandOf(minutesOfDay: number): TimeBand {
  if (minutesOfDay < 10 * 60) return 'morning';
  if (minutesOfDay < 16 * 60) return 'day';
  return 'evening';
}

export function dayTypeOf(weekday: number): DayType {
  return weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
}

export function factorKey(mode: TravelMode, band: TimeBand, dayType: DayType): string {
  return `${mode}:${band}:${dayType}`;
}

export function applyModel(baseSeconds: number, model: TravelModel, key: string): number {
  if (baseSeconds < 0) return -1;
  return Math.round(baseSeconds * (model.factors[key] ?? 1));
}

/** 地図APIが使えないときの概算（shared の estimateLeg と同じ） */
export const fallbackLeg = estimateLeg;

/**
 * 実測区間から倍率を学習する（中央値。外れ値に強い）。
 * 補完した区間（到着をはじめる時刻で補ったもの）は呼び出し側で除く。
 */
export function trainFactors(
  samples: { key: string; baseSeconds: number; actualSeconds: number }[],
  minSamples = 5,
): Record<string, number> {
  const byKey = new Map<string, number[]>();
  for (const s of samples) {
    if (s.baseSeconds <= 60 || s.actualSeconds <= 0) continue;
    const r = s.actualSeconds / s.baseSeconds;
    if (r < 0.3 || r > 4) continue;
    byKey.set(s.key, [...(byKey.get(s.key) ?? []), r]);
  }
  const out: Record<string, number> = {};
  for (const [k, rs] of byKey) {
    if (rs.length < minSamples) continue;
    const sorted = [...rs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    out[k] = Math.round(median * 1000) / 1000;
  }
  return out;
}

/** 予測誤差の指標（KPI）：±10分以内の割合と MAPE */
export function accuracy(pairs: { predicted: number; actual: number }[]): {
  within10: number;
  mape: number;
  n: number;
} {
  const valid = pairs.filter((p) => p.actual > 0);
  if (valid.length === 0) return { within10: 0, mape: 0, n: 0 };
  const within = valid.filter((p) => Math.abs(p.predicted - p.actual) <= 600).length;
  const mape = valid.reduce((s, p) => s + Math.abs(p.predicted - p.actual) / p.actual, 0) / valid.length;
  return { within10: within / valid.length, mape, n: valid.length };
}
