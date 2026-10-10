import { describe, expect, it } from 'vitest';
import { type EvalMatrix, evaluatePlan, evaluateRoute } from './routeEval';

const m: EvalMatrix = {
  index: { 'staff/s1': 0, 'clients/a': 1, 'clients/b': 2 },
  seconds: [
    [0, 600, 1200],
    [600, 0, 900],
    [1200, 900, 0],
  ],
  meters: [
    [0, 5000, 10000],
    [5000, 0, 7000],
    [10000, 7000, 0],
  ],
};
const staff = { staffId: 's1', homePointId: 'staff/s1', shiftStart: '08:00', shiftEnd: '18:00' };
const a = { visitId: 'va', pointId: 'clients/a', earliestStart: '09:00', latestStart: '09:00', durationMinutes: 60 };
const b = { visitId: 'vb', pointId: 'clients/b', earliestStart: '10:00', latestStart: '11:00', durationMinutes: 60 };

describe('evaluateRoute', () => {
  it('最初の訪問に間に合うように出発し、待ち時間と移動を数える', () => {
    const r = evaluateRoute(staff, [a, b], m);
    expect(r.stops[0]).toMatchObject({ arrival: 540, start: 540, end: 600, waitMinutes: 0 });
    expect(r.stops[1]).toMatchObject({ arrival: 615, start: 615, end: 675 });
    expect(r.travelSeconds).toBe(600 + 900 + 1200);
    expect(r.meters).toBe(22000);
    expect(r.violations).toBe(0);
  });

  it('時間の約束に遅れたら違反に数える', () => {
    const late = { ...a, earliestStart: '09:00', latestStart: '09:00' };
    const r = evaluateRoute(staff, [b, late], m);
    expect(r.stops[1]?.late).toBe(true);
    expect(r.violations).toBe(1);
  });
});

describe('evaluatePlan', () => {
  it('交通費は距離×単価', () => {
    const p = evaluatePlan({ s1: ['va', 'vb'] }, [staff], { va: a, vb: b }, m, 10);
    expect(p.fareYen).toBe(220);
    expect(p.perStaff.s1?.visitCount).toBe(2);
  });
});
