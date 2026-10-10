import { distanceMeters, type LatLng } from '@vrp/shared';

/**
 * 移動時間行列を「近い区間だけ地図APIで実測、残りは概算」で作るための純粋関数（ADR-0004）。
 * 遠い区間は最適解にまず入らないので、全組み合わせ（n×n）を地図APIに聞かない。
 */

/** 各地点から地図APIで実測する近傍の数 */
export const NEIGHBORS = 10;

/** 1回の行列作成で地図APIに聞く要素数の上限（課金の天井）。超えた分は概算で埋める */
export const MAX_FETCH_ELEMENTS = 1000;

/**
 * 実測する区間（i→j, i≠j）。j が i の近傍 k 件に入るか、i が j の近傍 k 件に入るもの。
 * 地点が k+1 以下なら全区間。課金の天井を超える分は、直線距離の近い順に残して切る。
 */
export function neighborPairs(points: LatLng[], k = NEIGHBORS, maxElements = MAX_FETCH_ELEMENTS): [number, number][] {
  const n = points.length;
  const dist = points.map((a) => points.map((b) => distanceMeters(a, b)));
  const want = points.map(() => new Set<number>());
  for (let i = 0; i < n; i++) {
    const near = [...Array(n).keys()]
      .filter((j) => j !== i)
      .sort((x, y) => dist[i]![x]! - dist[i]![y]! || x - y)
      .slice(0, k);
    for (const j of near) {
      want[i]!.add(j);
      want[j]!.add(i);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) for (const j of [...want[i]!].sort((x, y) => x - y)) pairs.push([i, j]);
  if (pairs.length <= maxElements) return pairs;
  return pairs
    .map((p, idx) => ({ p, d: dist[p[0]]![p[1]]!, idx }))
    .sort((x, y) => x.d - y.d || x.idx - y.idx)
    .slice(0, maxElements)
    .map((x) => x.p)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** 出発地ごとに到着地をまとめる（地図APIへの1リクエスト＝出発地1つ。余計な要素を課金させない） */
export function groupByOrigin(pairs: [number, number][]): { origin: number; destinations: number[] }[] {
  const m = new Map<number, number[]>();
  for (const [i, j] of pairs) m.set(i, [...(m.get(i) ?? []), j]);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([origin, destinations]) => ({ origin, destinations }));
}

/**
 * 概算の補正倍率：同じ行列の実測区間で「実測 ÷ 直線距離の概算」の中央値。
 * 遠い区間を実際より短く見積もるとソルバーが選んでしまうので、1 未満にはしない（上限 3）。
 * 実測が3件未満なら 1。
 */
export function estimateScale(samples: { actual: number; estimate: number }[]): number {
  const rs = samples
    .filter((s) => s.estimate > 60 && s.actual > 0)
    .map((s) => s.actual / s.estimate)
    .sort((a, b) => a - b);
  if (rs.length < 3) return 1;
  const mid = Math.floor(rs.length / 2);
  const median = rs.length % 2 ? rs[mid]! : (rs[mid - 1]! + rs[mid]!) / 2;
  return Math.min(3, Math.max(1, Math.round(median * 1000) / 1000));
}
