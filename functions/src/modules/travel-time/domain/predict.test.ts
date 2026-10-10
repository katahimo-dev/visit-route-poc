import { describe, expect, it } from 'vitest';
import { accuracy, applyModel, fallbackLeg, timeBandOf, trainFactors } from './predict';

describe('travel-time', () => {
  it('倍率を掛け、到達不能は -1 のまま', () => {
    expect(applyModel(600, { version: 'v1', factors: { k: 1.5 } }, 'k')).toBe(900);
    expect(applyModel(600, { version: 'v1', factors: {} }, 'k')).toBe(600);
    expect(applyModel(-1, { version: 'v1', factors: { k: 2 } }, 'k')).toBe(-1);
  });
  it('時間帯の区切り', () => {
    expect(timeBandOf(9 * 60 + 59)).toBe('morning');
    expect(timeBandOf(10 * 60)).toBe('day');
    expect(timeBandOf(16 * 60)).toBe('evening');
  });
  it('概算は距離に比例する', () => {
    const a = { lat: 38.26, lng: 140.87 };
    const b = { lat: 38.27, lng: 140.87 };
    const leg = fallbackLeg(a, b, 'DRIVE');
    expect(leg.meters).toBeGreaterThan(1300);
    expect(leg.seconds).toBeGreaterThan(150);
  });
  it('学習は中央値、件数が少ないキーは学習しない', () => {
    const s = (r: number) => ({ key: 'DRIVE:day:weekday', baseSeconds: 600, actualSeconds: 600 * r });
    expect(trainFactors([s(1.1), s(1.2), s(1.3), s(1.2), s(9)])).toEqual({});
    expect(trainFactors([s(1.1), s(1.2), s(1.3), s(1.2), s(1.25)])).toEqual({ 'DRIVE:day:weekday': 1.2 });
  });
  it('±10分以内の割合', () => {
    const r = accuracy([
      { predicted: 600, actual: 900 },
      { predicted: 600, actual: 1300 },
    ]);
    expect(r.within10).toBe(0.5);
  });
});
