import type { Client, Staff, Visit } from '@vrp/shared';
import { describe, expect, it } from 'vitest';
import { assign, NONE, reconcile, shift, slotsOf, warningsOf } from './model';

const visit = (id: string, earliestStart: string, extra: Partial<Visit> = {}): Visit & { id: string } => ({
  id,
  date: '2026-10-12',
  clientId: `c-${id}`,
  windowKind: 'fixed',
  earliestStart,
  latestStart: earliestStart,
  durationMinutes: 60,
  staffId: null,
  cancelled: false,
  note: '',
  ...extra,
});
const mapOf = (vs: (Visit & { id: string })[]) => new Map(vs.map((v) => [v.id, v]));

describe('reconcile', () => {
  it('保存済みの並びを保ち、消えた訪問を除き、新しい訪問は担当の列の時刻の位置か未割当へ入れる', () => {
    const vs = [visit('a', '09:00'), visit('b', '13:00'), visit('c', '11:00', { staffId: 's1' }), visit('d', '10:00')];
    const view = reconcile({ s1: ['b', 'a', 'gone'], [NONE]: [] }, vs, ['s1', 's2']);
    expect(view.cols.s1).toEqual(['b', 'a', 'c']);
    expect(view.cols.s2).toEqual([]);
    expect(view.unassigned).toEqual(['d']);
  });
});

describe('assign', () => {
  it('移した先の列では開始時刻の順の位置に入る', () => {
    const vs = [visit('a', '09:00'), visit('b', '13:00'), visit('c', '11:00')];
    const view = assign({ cols: { s1: ['a', 'b'] }, unassigned: ['c'] }, 'c', 's1', mapOf(vs));
    expect(view.cols.s1).toEqual(['a', 'c', 'b']);
    expect(view.unassigned).toEqual([]);
  });
  it('未割当に戻せる', () => {
    const vs = [visit('a', '09:00')];
    const view = assign({ cols: { s1: ['a'] }, unassigned: [] }, 'a', NONE, mapOf(vs));
    expect(view).toEqual({ cols: { s1: [] }, unassigned: ['a'] });
  });
});

describe('shift', () => {
  it('列の中で入れ替える。端では変えない', () => {
    const view = { cols: { s1: ['a', 'b'] }, unassigned: [] };
    expect(shift(view, 's1', 0, 1).cols.s1).toEqual(['b', 'a']);
    expect(shift(view, 's1', 0, -1)).toBe(view);
  });
});

describe('slotsOf', () => {
  it('前の訪問が終わるまで次は始められない。約束の時刻を過ぎたら late', () => {
    const vs = [
      visit('a', '09:00', { durationMinutes: 90 }),
      visit('b', '10:00', { windowKind: 'window', latestStart: '10:15' }),
    ];
    const slots = slotsOf(['a', 'b'], mapOf(vs));
    expect(slots.get('a')).toEqual({ start: '09:00', end: '10:30', late: false });
    expect(slots.get('b')).toEqual({ start: '10:30', end: '11:30', late: true });
  });
});

describe('warningsOf', () => {
  const staff: Staff = {
    name: 'テスト',
    email: 't@example.com',
    gender: 'male',
    home: { address: '', lat: null, lng: null },
    travelMode: 'DRIVE',
    workDays: [1, 2, 3, 4, 5],
    shiftStart: '08:00',
    shiftEnd: '18:00',
    active: true,
    uid: null,
  };
  const client: Client = {
    displayName: 'テスト',
    place: { address: '', lat: null, lng: null },
    requiredGender: 'female',
    note: '',
    color: 0,
    active: true,
  };
  it('勤務日・性別の希望・NG・遅れを印にする', () => {
    // 2026-10-11 は日曜
    expect(warningsOf('2026-10-11', staff, 's1', client, ['s1'], { start: '10:00', end: '11:00', late: true })).toEqual(
      ['off_day', 'gender', 'ng', 'late'],
    );
    expect(warningsOf('2026-10-12', staff, 's1', { ...client, requiredGender: null }, [], undefined)).toEqual([]);
  });
  it('未割当には印を付けない', () => {
    expect(warningsOf('2026-10-11', undefined, null, client, [], undefined)).toEqual([]);
  });
});
