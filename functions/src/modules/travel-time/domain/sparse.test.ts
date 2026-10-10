import { describe, expect, it } from 'vitest';
import { estimateScale, groupByOrigin, neighborPairs } from './sparse';

// 仙台駅のまわりに東西へ並べた地点（約1kmおき）
const line = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 38.26, lng: 140.88 + i * 0.0115 }));

describe('travel-time 近傍だけ実測', () => {
  it('地点が k+1 以下なら全区間', () => {
    expect(neighborPairs(line(4), 3)).toHaveLength(4 * 3);
  });
  it('近傍外の区間は含めず、要素数は n×k 程度に収まる', () => {
    const pairs = neighborPairs(line(60), 10);
    expect(pairs.length).toBeLessThan(60 * 59);
    expect(pairs.length).toBeLessThanOrEqual(60 * 10 * 2);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).not.toContainEqual([0, 59]);
    expect(pairs.every(([i, j]) => i !== j)).toBe(true);
  });
  it('片方の近傍に入れば逆向きも実測する', () => {
    const pairs = neighborPairs(line(30), 2);
    for (const [i, j] of pairs) expect(pairs).toContainEqual([j, i]);
  });
  it('課金の天井を超える分は近い区間を残して切る', () => {
    const pairs = neighborPairs(line(60), 10, 100);
    expect(pairs).toHaveLength(100);
    expect(pairs.every(([i, j]) => Math.abs(i - j) <= 1)).toBe(true);
  });
  it('同じ入力なら同じ結果', () => {
    expect(neighborPairs(line(20), 5)).toEqual(neighborPairs(line(20), 5));
  });
  it('出発地ごとにまとめる', () => {
    expect(
      groupByOrigin([
        [1, 0],
        [0, 2],
        [1, 2],
      ]),
    ).toEqual([
      { origin: 0, destinations: [2] },
      { origin: 1, destinations: [0, 2] },
    ]);
  });
  it('概算の倍率は実測の中央値。1 未満にせず、件数が少なければ 1', () => {
    const s = (r: number) => ({ actual: 600 * r, estimate: 600 });
    expect(estimateScale([s(1.2), s(1.4), s(1.6)])).toBe(1.4);
    expect(estimateScale([s(0.5), s(0.6), s(0.7)])).toBe(1);
    expect(estimateScale([s(5), s(6), s(7)])).toBe(3);
    expect(estimateScale([s(1.5), s(1.5)])).toBe(1);
  });
});
