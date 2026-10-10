import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-visit-route',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orgs/A'), { name: 'A' });
    await setDoc(doc(db, 'orgs/A/clients/c1'), { displayName: '山田さん' });
    await setDoc(doc(db, 'orgs/B/clients/c9'), { displayName: '他社の人' });
    await setDoc(doc(db, 'orgs/A/attendanceDays/s1_2026-10-20'), { staffId: 's1' });
    await setDoc(doc(db, 'orgs/A/attendanceDays/s2_2026-10-20'), { staffId: 's2' });
  });
});

const adminA = () => env.authenticatedContext('u-admin', { orgId: 'A', role: 'admin' }).firestore();
const staffA1 = () => env.authenticatedContext('u-s1', { orgId: 'A', role: 'staff', staffId: 's1' }).firestore();
const noClaims = () => env.authenticatedContext('u-x', {}).firestore();

const event = (staffId: string) => ({
  staffId,
  date: '2026-10-20',
  type: 'service_start',
  visitId: 'v1',
  source: 'button',
  clientTime: 1,
  lat: null,
  lng: null,
  accuracy: null,
});

describe('事業所の分離', () => {
  it('自分の事業所は読めて、別の事業所は読めない', async () => {
    await assertSucceeds(getDoc(doc(adminA(), 'orgs/A/clients/c1')));
    await assertFails(getDoc(doc(adminA(), 'orgs/B/clients/c9')));
    await assertFails(getDoc(doc(staffA1(), 'orgs/B/clients/c9')));
  });
  it('クレームのないユーザー（勝手に登録した人）は何も読めない', async () => {
    await assertFails(getDoc(doc(noClaims(), 'orgs/A/clients/c1')));
  });
});

describe('スタッフの記録', () => {
  it('本人の記録は作成でき、他人の名前では作成できない', async () => {
    await assertSucceeds(setDoc(doc(staffA1(), 'orgs/A/events/e1'), event('s1')));
    await assertFails(setDoc(doc(staffA1(), 'orgs/A/events/e2'), event('s2')));
  });
  it('記録は更新できない（再送で上書きしない）', async () => {
    await assertSucceeds(setDoc(doc(staffA1(), 'orgs/A/events/e1'), event('s1')));
    await assertFails(updateDoc(doc(staffA1(), 'orgs/A/events/e1'), { clientTime: 2 }));
  });
  it('管理者は uid の無いスタッフを作って編集でき、uid は書き換えられない', async () => {
    const s = {
      name: 'a',
      email: 'a@example.com',
      gender: 'female',
      home: {},
      travelMode: 'DRIVE',
      workDays: [1],
      shiftStart: '08:00',
      shiftEnd: '17:00',
      active: true,
    };
    await assertSucceeds(setDoc(doc(adminA(), 'orgs/A/staff/x'), s));
    await assertSucceeds(setDoc(doc(adminA(), 'orgs/A/staff/x'), { ...s, name: 'b' }));
    await assertFails(setDoc(doc(adminA(), 'orgs/A/staff/x'), { ...s, uid: 'evil' }));
  });
  it('スタッフはマスタを書けない', async () => {
    await assertFails(setDoc(doc(staffA1(), 'orgs/A/clients/c2'), { displayName: 'x' }));
  });
  it('勤怠は本人の分だけ読め、誰も直接書けない', async () => {
    await assertSucceeds(getDoc(doc(staffA1(), 'orgs/A/attendanceDays/s1_2026-10-20')));
    await assertFails(getDoc(doc(staffA1(), 'orgs/A/attendanceDays/s2_2026-10-20')));
    await assertFails(setDoc(doc(adminA(), 'orgs/A/attendanceDays/s1_2026-10-20'), { staffId: 's1' }));
  });
  it('生の位置は管理者も読めない', async () => {
    await assertFails(getDoc(doc(adminA(), 'orgs/A/locationSamples/x')));
  });
});
