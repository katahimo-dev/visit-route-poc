import type { Client, ClientPrivate, Org, Staff, Visit } from '@vrp/shared';
import { describe, expect, it } from 'vitest';
import { prepare } from './buildSolve';

const org: Org = {
  name: 'A',
  industry: 'care',
  terms: { client: '利用者さん', staff: 'ヘルパー' },
  optimizeMode: 'order_only',
  geofenceMeters: 100,
  showAiToStaff: false,
  fareYenPerKm: 10,
};
const staff = (id: string, lat: number | null, workDays = [1]): Staff & { id: string } => ({
  id,
  name: id,
  email: `${id}@example.com`,
  gender: 'female',
  home: { address: '', lat, lng: lat === null ? null : 140.8 },
  travelMode: 'DRIVE',
  workDays,
  shiftStart: '08:00',
  shiftEnd: '18:00',
  active: true,
  uid: null,
});
const client = (lat: number | null, extra: Partial<Client & ClientPrivate> = {}): Client & ClientPrivate => ({
  displayName: 'x',
  place: { address: '', lat, lng: lat === null ? null : 140.9 },
  requiredGender: null,
  ngStaffIds: [],
  note: '',
  color: 0,
  active: true,
  ...extra,
});
const visit = (
  id: string,
  clientId: string,
  staffId: string | null,
  kind: 'fixed' | 'window' = 'fixed',
): Visit & { id: string } => ({
  id,
  date: '2026-10-19',
  clientId,
  windowKind: kind,
  earliestStart: '09:00',
  latestStart: '10:00',
  durationMinutes: 60,
  staffId,
  cancelled: false,
  note: '',
});

describe('prepare', () => {
  it('位置の無いスタッフ・訪問先を除外し、理由を返す', () => {
    const p = prepare(
      {
        org,
        staff: [staff('s1', 38.2), staff('s2', null)],
        clients: new Map([
          ['c1', client(38.3, { requiredGender: 'female', ngStaffIds: ['s9'] })],
          ['c2', client(null)],
        ]),
        visits: [visit('v1', 'c1', 's1'), visit('v2', 'c2', 's1')],
        manualRoutes: { s1: ['v1', 'v2'] },
        availability: new Map(),
      },
      '2026-10-19',
    );
    expect(p.skipped).toEqual([
      { kind: 'staff', id: 's2', reason: 'no_location' },
      { kind: 'visit', id: 'v2', reason: 'no_location' },
    ]);
    expect(p.request.visits[0]).toMatchObject({ currentStaffId: 's1', requiredGender: 'female', ngStaffIds: ['s9'] });
    // fixed は開始幅を潰す
    expect(p.request.visits[0]?.window.latestStart).toBe('09:00');
    expect(p.points.map((x) => x.id)).toEqual(['staff/s1', 'clients/c1']);
  });

  it('勤務日でも担当でもないスタッフは対象外', () => {
    const p = prepare(
      {
        org,
        staff: [staff('s1', 38.2, [2])],
        clients: new Map(),
        visits: [],
        manualRoutes: {},
        availability: new Map(),
      },
      '2026-10-19',
    );
    expect(p.staffIn).toEqual([]);
  });
});

describe('prepare：稼働時間帯（ADR-0008）', () => {
  const base = { org, clients: new Map(), visits: [], manualRoutes: {} };
  it('上書きがあれば、その日の時間帯を勤務時間に、あいだの抜けを休みにする', () => {
    const p = prepare(
      {
        ...base,
        staff: [staff('s1', 38.2)],
        availability: new Map([
          [
            's1',
            {
              slots: [
                { start: '09:00', end: '12:00' },
                { start: '14:00', end: '17:30' },
              ],
            },
          ],
        ]),
      },
      '2026-10-19',
    );
    expect(p.request.staff[0]).toMatchObject({
      shiftStart: '09:00',
      shiftEnd: '17:30',
      breaks: [{ start: '12:00', end: '14:00' }],
    });
    expect(p.staffIn[0]?.breaks).toEqual([{ start: '12:00', end: '14:00' }]);
  });
  it('勤務日でも休みに上書きした日は対象外。勤務日でない日に時間帯を入れれば対象', () => {
    const off = prepare(
      { ...base, staff: [staff('s1', 38.2)], availability: new Map([['s1', { slots: [] }]]) },
      '2026-10-19',
    );
    expect(off.staffIn).toEqual([]);
    const extra = prepare(
      {
        ...base,
        staff: [staff('s1', 38.2, [2])],
        availability: new Map([['s1', { slots: [{ start: '10:00', end: '15:00' }] }]]),
      },
      '2026-10-19',
    );
    expect(extra.request.staff[0]).toMatchObject({ shiftStart: '10:00', shiftEnd: '15:00' });
    expect(extra.request.staff[0]).not.toHaveProperty('breaks');
  });
});

describe('prepare：休みの日に手作業の担当がある人', () => {
  it('最適化では訪問を持たせず、評価では休みの印を付ける', () => {
    const p = prepare(
      {
        org,
        staff: [staff('s1', 38.2)],
        clients: new Map([['c1', client(38.3)]]),
        visits: [visit('v1', 'c1', 's1')],
        manualRoutes: { s1: ['v1'] },
        availability: new Map([['s1', { slots: [] }]]),
      },
      '2026-10-19',
    );
    expect(p.request.staff[0]).toMatchObject({ staffId: 's1', maxVisits: 0 });
    expect(p.staffIn[0]).toMatchObject({ staffId: 's1', off: true });
  });
});
