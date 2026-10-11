import { describe, expect, it } from 'vitest';
import { availabilitySchema } from '../contracts/documents';
import {
  availabilityOf,
  normalizeSlots,
  shiftOf,
  slotsError,
  slotsText,
  toHalfHours,
  withinSlots,
} from './availability';

const base = { workDays: [1, 2, 3, 4, 5], shiftStart: '08:00', shiftEnd: '18:00' };
// 2026-10-12 は月曜、2026-10-11 は日曜

describe('availabilityOf', () => {
  it('上書きが無ければ基本の曜日と時間', () => {
    expect(availabilityOf(base, '2026-10-12', null)).toEqual({
      slots: [{ start: '08:00', end: '18:00' }],
      overridden: false,
    });
    expect(availabilityOf(base, '2026-10-11', undefined).slots).toEqual([]);
  });
  it('上書きがあればそれ。空ならその日は休み', () => {
    expect(availabilityOf(base, '2026-10-12', { slots: [] })).toEqual({ slots: [], overridden: true });
    const sunday = [{ start: '09:00', end: '12:00' }];
    expect(availabilityOf(base, '2026-10-11', { slots: sunday }).slots).toEqual(sunday);
  });
});

describe('slotsError', () => {
  it('30分単位・開始＜終了・重なりなし・上限', () => {
    expect(
      slotsError([
        { start: '09:00', end: '12:00' },
        { start: '13:30', end: '18:00' },
      ]),
    ).toBeNull();
    expect(slotsError([{ start: '09:15', end: '12:00' }])).toMatch('30分');
    expect(slotsError([{ start: '12:00', end: '12:00' }])).toMatch('後に');
    expect(
      slotsError([
        { start: '09:00', end: '12:00' },
        { start: '11:30', end: '13:00' },
      ]),
    ).toMatch('重なって');
    const five = Array.from({ length: 5 }, (_, i) => ({ start: `1${i}:00`, end: `1${i}:30` }));
    expect(slotsError(five)).toMatch('4つ');
  });
  it('文書の検査でも同じ規則を使う', () => {
    const doc = { staffId: 's1', date: '2026-10-12', byStaff: true, updatedBy: 'u', updatedAt: 1 };
    expect(availabilitySchema.safeParse({ ...doc, slots: [{ start: '09:00', end: '12:00' }] }).success).toBe(true);
    expect(availabilitySchema.safeParse({ ...doc, slots: [{ start: '12:00', end: '09:00' }] }).success).toBe(false);
    expect(availabilitySchema.safeParse({ ...doc, slots: [{ start: '09:10', end: '12:00' }] }).success).toBe(false);
  });
});

describe('normalizeSlots', () => {
  it('開始の順に並べ、重なり・くっついた時間帯をまとめる', () => {
    expect(
      normalizeSlots([
        { start: '14:00', end: '18:00' },
        { start: '09:00', end: '12:00' },
        { start: '12:00', end: '13:00' },
        { start: '15:00', end: '16:00' },
      ]),
    ).toEqual([
      { start: '09:00', end: '13:00' },
      { start: '14:00', end: '18:00' },
    ]);
  });
});

describe('toHalfHours', () => {
  it('開始は切り捨て、終了は切り上げで30分単位にする', () => {
    expect(toHalfHours([{ start: '09:15', end: '17:45' }])).toEqual([{ start: '09:00', end: '18:00' }]);
    expect(toHalfHours([{ start: '23:10', end: '23:50' }])).toEqual([{ start: '23:00', end: '23:30' }]);
  });
});

describe('withinSlots・shiftOf・slotsText', () => {
  const slots = [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ];
  it('訪問が1つの時間帯に収まるか', () => {
    expect(withinSlots(slots, 9 * 60, 10 * 60)).toBe(true);
    expect(withinSlots(slots, 11 * 60 + 30, 12 * 60 + 30)).toBe(false);
    expect(withinSlots([], 9 * 60, 10 * 60)).toBe(false);
  });
  it('最適化の入力：勤務の始まり・終わりとあいだの休み', () => {
    expect(shiftOf(slots)).toEqual({
      shiftStart: '09:00',
      shiftEnd: '18:00',
      breaks: [{ start: '12:00', end: '14:00' }],
    });
    expect(shiftOf([])).toBeNull();
  });
  it('表示', () => {
    expect(slotsText(slots)).toBe('9:00〜12:00・14:00〜18:00');
    expect(slotsText([])).toBe('休み');
  });
});
