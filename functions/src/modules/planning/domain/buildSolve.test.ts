import type { Client, Org, Staff, Visit } from '@vrp/shared';
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
const client = (lat: number | null, extra: Partial<Client> = {}): Client => ({
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
        weekday: 1,
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
      { org, staff: [staff('s1', 38.2, [2])], clients: new Map(), visits: [], manualRoutes: {}, weekday: 1 },
      '2026-10-19',
    );
    expect(p.staffIn).toEqual([]);
  });
});
