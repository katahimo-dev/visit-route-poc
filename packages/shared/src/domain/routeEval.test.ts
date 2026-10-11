import { describe, expect, it } from 'vitest';
import { type EvalMatrix, evaluatePlan, evaluateRoute, routeViews } from './routeEval';

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

  it('作業が休みにかかるなら休み明けまで待って始め、約束の幅に収まれば違反にしない（休みは待ちに数えない）', () => {
    const lunch = { ...staff, breaks: [{ start: '10:30', end: '11:00' }] };
    const r = evaluateRoute(lunch, [a, b], m);
    expect(r.stops[1]).toMatchObject({ arrival: 615, start: 660, waitMinutes: 30 - 15 });
    expect(r.violations).toBe(0);
    // 時間の固定された訪問は、休み明けまで待つと遅れる
    const fixed = { ...b, latestStart: '10:00' };
    expect(evaluateRoute(lunch, [a, fixed], m).violations).toBe(1);
  });
  it('移動が休みにかかるのはよい', () => {
    const morning = { ...staff, breaks: [{ start: '08:30', end: '09:00' }] };
    expect(evaluateRoute(morning, [a, b], m).violations).toBe(0);
  });
  it('休みの日に担当がある人は、訪問1件ごとに違反', () => {
    expect(evaluateRoute({ ...staff, off: true }, [a, b], m).violations).toBe(2);
  });
});

describe('evaluatePlan', () => {
  it('交通費は距離×単価', () => {
    const p = evaluatePlan({ s1: ['va', 'vb'] }, [staff], { va: a, vb: b }, m, 10);
    expect(p.fareYen).toBe(220);
    expect(p.perStaff.s1?.visitCount).toBe(2);
  });
});

describe('routeViews', () => {
  const est: EvalMatrix = { ...m, seconds: m.seconds.map((row) => row.map((x) => x / 2)) };
  it('手作業案・AI案を同じ形で、区間の移動と概算の値を並べる', () => {
    const v = routeViews({ s1: ['va', 'vb'] }, [staff], { va: a, vb: b }, m, est);
    expect(v.s1?.stops).toEqual([
      { visitId: 'va', start: 540, end: 600, travelMinutes: 10, estimateMinutes: 5, late: false },
      { visitId: 'vb', start: 615, end: 675, travelMinutes: 15, estimateMinutes: 7.5, late: false },
    ]);
    expect(v.s1).toMatchObject({
      backMinutes: 20,
      backEstimateMinutes: 10,
      travelMinutes: 45,
      estimateTravelMinutes: 22.5,
    });
  });
  it('概算が無ければ null。訪問の無い人は出さない', () => {
    const v = routeViews({ s1: ['va'] }, [staff, { ...staff, staffId: 's2' }], { va: a }, m, null);
    expect(v.s1?.stops[0]?.estimateMinutes).toBeNull();
    expect(v.s1?.estimateTravelMinutes).toBeNull();
    expect(v.s2).toBeUndefined();
  });
});
