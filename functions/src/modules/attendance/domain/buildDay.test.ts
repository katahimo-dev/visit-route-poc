import { jstToMs, type VisitEvent } from '@vrp/shared';
import { describe, expect, it } from 'vitest';
import { buildAttendanceDay } from './buildDay';

const D = '2026-10-20';
const t = (hhmm: string) => jstToMs(D, hhmm);
const ev = (type: VisitEvent['type'], visitId: string | null, hhmm: string): VisitEvent => ({
  staffId: 's1',
  date: D,
  type,
  visitId,
  source: 'button',
  clientTime: t(hhmm),
  lat: null,
  lng: null,
  accuracy: null,
});
const planned = [
  { visitId: 'v1', earliestStart: '09:00', durationMinutes: 60 },
  { visitId: 'v2', earliestStart: '11:00', durationMinutes: 120 },
];

describe('buildAttendanceDay', () => {
  it('実働・移動・休憩・拘束を集計する', () => {
    const day = buildAttendanceDay(
      's1',
      D,
      planned,
      [
        ev('arrive', 'v1', '08:55'),
        ev('service_start', 'v1', '09:00'),
        ev('service_end', 'v1', '10:00'),
        ev('depart', 'v1', '10:05'),
        ev('arrive', 'v2', '10:35'),
        ev('service_start', 'v2', '11:00'),
        ev('service_end', 'v2', '12:00'),
      ],
      null,
    );
    expect(day.totals).toEqual({ workMinutes: 120, travelMinutes: 30, breakMinutes: 35, boundMinutes: 185 });
    expect(day.visits[1]?.changed).toBe(true); // 2時間予定が1時間
    expect(day.visits[0]?.changed).toBe(false);
    expect(day.status).toBe('candidate');
  });

  it('到着が無ければはじめる時刻で補い、印を付ける', () => {
    const day = buildAttendanceDay('s1', D, planned.slice(0, 1), [ev('service_start', 'v1', '09:02')], null);
    expect(day.visits[0]?.arrive).toBe(t('09:02'));
    expect(day.visits[0]?.arriveFilled).toBe(true);
  });

  it('訂正は再計算しても残り、承認済みは承認のまま', () => {
    const first = buildAttendanceDay('s1', D, planned.slice(0, 1), [ev('service_start', 'v1', '09:00')], null);
    const prev = {
      ...first,
      status: 'approved' as const,
      approvedBy: 'u',
      visits: first.visits.map((v) => ({ ...v, corrections: { end: t('10:00') } })),
    };
    const again = buildAttendanceDay('s1', D, planned.slice(0, 1), [ev('service_start', 'v1', '09:00')], prev);
    expect(again.visits[0]?.corrections.end).toBe(t('10:00'));
    expect(again.totals.workMinutes).toBe(60);
    expect(again.status).toBe('approved');
    expect(again.version).toBe(first.version + 1);
  });
});
