/**
 * エミュレーター用のデモデータ（仙台市内の架空の事業所）。本番では実行しない。
 *   pnpm seed   （firebase emulators:start の起動中に）
 * ログイン：admin@example.com（管理者）/ staff1@example.com（スタッフ）/ operator@example.com（運営者）
 * ログインコードはエミュレーターの関数ログ（http://localhost:4000/logs）に表示される。
 * 実証用のプロジェクトに入れるとき（デモ期間）：SEED_PROJECT=<プロジェクトID> pnpm seed
 *   事業所 demo にだけ書く。デモの印の無い事業所 demo（実データ）があれば止まる。片付けは scripts/endDemo.ts
 * 予定は実行日から SEED_UNTIL（既定 2026-11-30）まで毎日入る（土日も営業）。日ごとに少しずつ変える。
 */
import {
  addDays,
  type Client,
  type ClientPrivate,
  DEFAULT_TERMS,
  hhmmToMinutes,
  jstDate,
  minutesToHhmm,
  type Org,
  type Staff,
  type Visit,
  weekday,
} from '@vrp/shared';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const target = process.env.SEED_PROJECT;
if (!target && !process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
}
initializeApp({ projectId: target ?? 'demo-visit-route' });
const db = getFirestore();
const auth = getAuth();
const orgId = 'demo';

const org: Org = {
  name: 'デモ訪問サービス（架空）',
  industry: 'care',
  terms: DEFAULT_TERMS.care,
  optimizeMode: 'assign_and_order',
  geofenceMeters: 100,
  showAiToStaff: false,
  fareYenPerKm: 10,
  demo: true,
};

// 実データの事業所 demo を上書きしない
const existing = (await db.doc(`orgs/${orgId}`).get()).data() as Org | undefined;
if (existing && existing.demo !== true) {
  console.error('事業所 demo にデモの印がありません（実データの可能性）。中止します');
  process.exit(1);
}

/**
 * スタッフ・訪問先は、仙台市の公共施設を擬人化した架空の人物（住所・位置は施設のおおよその場所）。
 * 実在の個人の情報は使わない。
 */
const staff: Record<string, Staff> = {
  s1: {
    name: '市役所 まち子',
    email: 'staff1@example.com',
    gender: 'female',
    home: { address: '仙台市青葉区国分町3丁目（仙台市役所）', lat: 38.2683, lng: 140.8694 },
    travelMode: 'DRIVE',
    workDays: [1, 2, 3, 4, 5],
    shiftStart: '08:00',
    shiftEnd: '18:00',
    active: true,
    uid: null,
  },
  s2: {
    name: '長町 小太郎',
    email: 'staff2@example.com',
    gender: 'male',
    home: { address: '仙台市太白区長町（長町小学校）', lat: 38.2264, lng: 140.8853 },
    travelMode: 'DRIVE',
    workDays: [1, 2, 3, 4, 5],
    shiftStart: '08:00',
    shiftEnd: '18:00',
    active: true,
    uid: null,
  },
  s3: {
    name: '榴岡 さくら',
    email: 'staff3@example.com',
    gender: 'female',
    home: { address: '仙台市宮城野区榴岡（榴岡小学校）', lat: 38.2593, lng: 140.893 },
    travelMode: 'DRIVE',
    workDays: [0, 1, 2, 3, 4, 5, 6],
    shiftStart: '08:00',
    shiftEnd: '18:00',
    active: true,
    uid: null,
  },
};

const clients: Record<string, Client & ClientPrivate> = {
  c1: {
    displayName: '図書館 ふみ',
    place: { address: '仙台市青葉区春日町（せんだいメディアテーク）', lat: 38.2654, lng: 140.8656 },
    requiredGender: null,
    ngStaffIds: [],
    note: '本の返却日を気にしています',
    color: 2,
    active: true,
  },
  c2: {
    displayName: '動物公園 やぎお',
    place: { address: '仙台市太白区八木山本町（八木山動物公園）', lat: 38.2489, lng: 140.8467 },
    requiredGender: null,
    ngStaffIds: ['s2'],
    note: '坂の上です。冬は路面に注意',
    color: 0,
    active: true,
  },
  c3: {
    displayName: '泉図書館 いずみ',
    place: { address: '仙台市泉区泉中央（泉図書館）', lat: 38.3245, lng: 140.8805 },
    requiredGender: null,
    ngStaffIds: [],
    note: '',
    color: 4,
    active: true,
  },
  c4: {
    displayName: '若林図書館 わかば',
    place: { address: '仙台市若林区南小泉（若林図書館）', lat: 38.2404, lng: 140.9024 },
    requiredGender: null,
    ngStaffIds: [],
    note: 'かぎはポストへ',
    color: 7,
    active: true,
  },
  c5: {
    displayName: '博物館 れきこ',
    place: { address: '仙台市青葉区川内（仙台市博物館）', lat: 38.2558, lng: 140.8611 },
    requiredGender: null,
    ngStaffIds: [],
    note: 'うす味が好き',
    color: 3,
    active: true,
  },
  c6: {
    displayName: '科学館 ひかる',
    place: { address: '仙台市青葉区台原森林公園（仙台市科学館）', lat: 38.2925, lng: 140.8781 },
    requiredGender: 'female',
    ngStaffIds: [],
    note: '香りにびんかん',
    color: 1,
    active: true,
  },
};

/** 手作業らしい（遠回りの）割当 */
const plan: [string, string, 'fixed' | 'window', string, string, number][] = [
  // [visitId, clientId, 時間の約束, 開始(最早), 開始(最遅), 分]
  ['v1', 'c1', 'fixed', '09:00', '09:00', 60],
  ['v2', 'c2', 'window', '10:30', '11:30', 60],
  ['v3', 'c3', 'fixed', '13:00', '13:00', 90],
  ['v4', 'c4', 'window', '09:30', '10:30', 60],
  ['v5', 'c5', 'window', '11:00', '12:00', 60],
  ['v6', 'c6', 'fixed', '14:00', '14:00', 60],
];
const manualRoutes: Record<string, string[]> = { s1: ['v1', 'v2', 'v3'], s2: ['v4', 'v5'], s3: ['v6'] };

const until = process.env.SEED_UNTIL ?? '2026-11-30';
const isWeekend = (date: string) => weekday(date) === 0 || weekday(date) === 6;
/** 土日の手作業案：s3 が1人で回る */
const routesOf = (date: string): Record<string, string[]> =>
  isWeekend(date) ? { s3: ['v1', 'v4', 'v6'] } : manualRoutes;
const shift = (hhmm: string, min: number) => minutesToHhmm(hhmmToMinutes(hhmm) + min);
const dates: string[] = [];
for (let d = jstDate(Date.now()); d <= until; d = addDays(d, 1)) dates.push(d);

/**
 * 日ごとの変化（同じ日なら毎回同じ）：時間に幅のある訪問は 0〜60分ずらす。
 * 土日は榴岡 さくら（s3）が3件を回る。平日は4日に1回は博物館が休み。
 */
function plansOf(date: string, n: number): typeof plan {
  if (isWeekend(date)) return plan.filter(([id]) => id === 'v1' || id === 'v4' || id === 'v6');
  return plan
    .filter(([id]) => !(id === 'v5' && n % 4 === 3))
    .map(([id, c, kind, e, l, mins]) =>
      kind === 'window'
        ? [id, c, kind, shift(e, (n % 3) * 30), shift(l, (n % 3) * 30), mins]
        : [id, c, kind, e, l, mins],
    );
}

for (const [n, date] of dates.entries()) {
  const batch = db.batch();
  const today = plansOf(date, n);
  for (const [id, clientId, kind, e, l, mins] of today) {
    const staffId = Object.entries(routesOf(date)).find(([, ids]) => ids.includes(id))?.[0] ?? null;
    const v: Visit = {
      date,
      clientId,
      windowKind: kind,
      earliestStart: e,
      latestStart: l,
      durationMinutes: mins,
      staffId,
      cancelled: false,
      note: '',
    };
    batch.set(db.doc(`orgs/${orgId}/visits/${date}_${id}`), v);
  }
  const ids = new Set(today.map(([id]) => id));
  const routes = Object.fromEntries(
    Object.entries(routesOf(date)).map(([s, vs]) => [s, vs.filter((id) => ids.has(id)).map((id) => `${date}_${id}`)]),
  );
  batch.set(db.doc(`orgs/${orgId}/manualPlans/${date}`), {
    date,
    routes,
    minutesSpent: 25,
    updatedBy: 'seed',
    updatedAt: Date.now(),
  });
  await batch.commit();
}

await db.doc(`orgs/${orgId}`).set(org);
for (const [id, s] of Object.entries(staff)) await db.doc(`orgs/${orgId}/staff/${id}`).set(s);
for (const [id, { ngStaffIds, ...c }] of Object.entries(clients)) {
  await db.doc(`orgs/${orgId}/clients/${id}`).set(c);
  // NG スタッフは管理者だけが読む文書に分ける
  await db.doc(`orgs/${orgId}/clientPrivate/${id}`).set({ ngStaffIds });
}

async function user(email: string, claims: Record<string, string>) {
  const u = await auth.getUserByEmail(email).catch(() => auth.createUser({ email }));
  await auth.setCustomUserClaims(u.uid, claims);
  return u.uid;
}
await user('operator@example.com', { role: 'operator' });
await user('admin@example.com', { orgId, role: 'admin' });
for (const [id, s] of Object.entries(staff)) {
  const uid = await user(s.email, { orgId, role: 'staff', staffId: id });
  await db.doc(`orgs/${orgId}/staff/${id}`).update({ uid });
}
console.log(`デモデータを入れました（事業所 demo、${dates[0]}〜${until} の ${dates.length} 日分の予定）`);
