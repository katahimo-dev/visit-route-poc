/**
 * エミュレーター用のデモデータ（仙台市内の架空の事業所）。本番では実行しない。
 *   pnpm seed   （firebase emulators:start の起動中に）
 * ログイン：admin@example.com（管理者）/ staff1〜8@example.com（スタッフ）/ operator@example.com（運営者）
 * ログインコードはエミュレーターの関数ログ（http://localhost:4000/logs）に表示される。
 * 実証用のプロジェクトに入れるとき（デモ期間）：SEED_PROJECT=<プロジェクトID> pnpm seed
 *   事業所 demo にだけ書く。デモの印の無い事業所 demo（実データ）があれば止まる。片付けは scripts/endDemo.ts
 * 予定は実行日から SEED_UNTIL（既定 2026-11-30）まで毎日入る（土日も営業）。日ごとに少しずつ変える。
 * 入れ直すと、実行日以降の訪問・手作業案・AI案は作り直す（過去の記録・勤怠は消さない）。
 */
import {
  addDays,
  type Client,
  type ClientPrivate,
  DEFAULT_TERMS,
  type Gender,
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
const person = (
  n: number,
  name: string,
  gender: Gender,
  address: string,
  lat: number,
  lng: number,
  workDays: number[],
  shift: [string, string] = ['08:00', '18:00'],
): [string, Staff] => [
  `s${n}`,
  {
    name,
    email: `staff${n}@example.com`,
    gender,
    home: { address, lat, lng },
    travelMode: 'DRIVE',
    workDays,
    shiftStart: shift[0],
    shiftEnd: shift[1],
    active: true,
    uid: null,
  },
];
const WEEKDAYS = [1, 2, 3, 4, 5];
const staff: Record<string, Staff> = Object.fromEntries([
  person(1, '市役所 まち子', 'female', '仙台市青葉区国分町3丁目（仙台市役所）', 38.2683, 140.8694, WEEKDAYS),
  person(2, '長町 小太郎', 'male', '仙台市太白区長町（長町小学校）', 38.2264, 140.8853, WEEKDAYS),
  person(3, '榴岡 さくら', 'female', '仙台市宮城野区榴岡（榴岡小学校）', 38.2593, 140.893, [0, 1, 2, 3, 4, 5, 6]),
  person(4, '消防 まもる', 'male', '仙台市青葉区堤通雨宮町（仙台市消防局）', 38.2753, 140.8721, WEEKDAYS),
  person(
    5,
    '体育館 つよし',
    'male',
    '仙台市太白区富沢（仙台市体育館）',
    38.2203,
    140.87,
    [1, 2, 3, 4, 6],
    ['09:00', '17:00'],
  ),
  person(6, '文化 かなで', 'female', '仙台市青葉区旭ケ丘（青年文化センター）', 38.2875, 140.8797, [2, 3, 4, 5, 6]),
  person(
    7,
    '野草園 すみれ',
    'female',
    '仙台市太白区茂ケ崎（仙台市野草園）',
    38.2408,
    140.874,
    [0, 1, 3, 5],
    ['08:30', '16:30'],
  ),
  person(8, '宮城野 はぎお', 'male', '仙台市宮城野区五輪（宮城野区役所）', 38.2601, 140.9013, [0, 1, 2, 4, 5]),
]);

type ClientSeed = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** 平日の約束：[時間の約束, 開始(最早), 開始(最遅), 分] */
  slot: ['fixed' | 'window', string, string, number];
  requiredGender?: 'female' | 'male';
  ng?: string[];
  note?: string;
  /** 土日も訪問する */
  weekend?: boolean;
};
const clientSeeds: ClientSeed[] = [
  {
    id: 'c1',
    name: '図書館 ふみ',
    address: '仙台市青葉区春日町（せんだいメディアテーク）',
    lat: 38.2654,
    lng: 140.8656,
    slot: ['fixed', '09:00', '09:00', 60],
    note: '本の返却日を気にしています',
    weekend: true,
  },
  {
    id: 'c2',
    name: '動物公園 やぎお',
    address: '仙台市太白区八木山本町（八木山動物公園）',
    lat: 38.2489,
    lng: 140.8467,
    slot: ['window', '10:30', '11:30', 60],
    ng: ['s2'],
    note: '坂の上です。冬は路面に注意',
  },
  {
    id: 'c3',
    name: '泉図書館 いずみ',
    address: '仙台市泉区泉中央（泉図書館）',
    lat: 38.3245,
    lng: 140.8805,
    slot: ['fixed', '13:00', '13:00', 90],
  },
  {
    id: 'c4',
    name: '若林図書館 わかば',
    address: '仙台市若林区南小泉（若林図書館）',
    lat: 38.2404,
    lng: 140.9024,
    slot: ['window', '09:30', '10:30', 60],
    note: 'かぎはポストへ',
    weekend: true,
  },
  {
    id: 'c5',
    name: '博物館 れきこ',
    address: '仙台市青葉区川内（仙台市博物館）',
    lat: 38.2558,
    lng: 140.8611,
    slot: ['window', '11:00', '12:00', 60],
    note: 'うす味が好き',
  },
  {
    id: 'c6',
    name: '科学館 ひかる',
    address: '仙台市青葉区台原森林公園（仙台市科学館）',
    lat: 38.2925,
    lng: 140.8781,
    slot: ['fixed', '14:00', '14:00', 60],
    requiredGender: 'female',
    note: '香りにびんかん',
    weekend: true,
  },
  {
    id: 'c7',
    name: '天文台 ほしみ',
    address: '仙台市青葉区錦ケ丘（仙台市天文台）',
    lat: 38.2557,
    lng: 140.7716,
    slot: ['fixed', '10:00', '10:00', 45],
    note: '夜ふかしなので午前はゆっくり',
  },
  {
    id: 'c8',
    name: '文学館 しおり',
    address: '仙台市青葉区北根（仙台文学館）',
    lat: 38.2935,
    lng: 140.8691,
    slot: ['window', '13:30', '14:30', 60],
  },
  {
    id: 'c9',
    name: '地底の森 もりお',
    address: '仙台市太白区長町南（地底の森ミュージアム）',
    lat: 38.2195,
    lng: 140.8783,
    slot: ['fixed', '09:00', '09:00', 30],
    weekend: true,
  },
  {
    id: 'c10',
    name: '市民会館 ひびき',
    address: '仙台市青葉区桜ケ岡公園（仙台市民会館）',
    lat: 38.2648,
    lng: 140.8627,
    slot: ['window', '15:00', '16:00', 45],
    note: '音に敏感。チャイムは1回',
  },
  {
    id: 'c11',
    name: '市場 うおすけ',
    address: '仙台市若林区卸町（中央卸売市場）',
    lat: 38.2556,
    lng: 140.929,
    slot: ['fixed', '08:30', '08:30', 30],
    requiredGender: 'male',
    note: '朝が早い',
  },
  {
    id: 'c12',
    name: '荒浜 なぎさ',
    address: '仙台市若林区荒浜（震災遺構 荒浜小学校）',
    lat: 38.223,
    lng: 140.98,
    slot: ['window', '10:00', '11:00', 60],
    ng: ['s7'],
    weekend: true,
  },
  {
    id: 'c13',
    name: 'メモリアル あかり',
    address: '仙台市若林区荒井（せんだい3.11メモリアル交流館）',
    lat: 38.239,
    lng: 140.942,
    slot: ['fixed', '14:30', '14:30', 60],
  },
  {
    id: 'c14',
    name: '城跡 ほまれ',
    address: '仙台市青葉区川内（仙台城跡）',
    lat: 38.2526,
    lng: 140.856,
    slot: ['window', '09:00', '10:00', 45],
    note: '階段が多い家',
  },
  {
    id: 'c15',
    name: '七北田公園 ななこ',
    address: '仙台市泉区七北田（七北田公園）',
    lat: 38.3215,
    lng: 140.8885,
    slot: ['fixed', '15:30', '15:30', 60],
    weekend: true,
  },
  {
    id: 'c16',
    name: '陸上競技場 かける',
    address: '仙台市宮城野区宮城野（仙台市陸上競技場）',
    lat: 38.2596,
    lng: 140.9045,
    slot: ['window', '13:00', '14:00', 30],
  },
  {
    id: 'c17',
    name: '交通局 のりこ',
    address: '仙台市青葉区木町通（仙台市交通局）',
    lat: 38.2706,
    lng: 140.8668,
    slot: ['fixed', '11:30', '11:30', 45],
  },
  {
    id: 'c18',
    name: '福祉プラザ やすら',
    address: '仙台市青葉区五橋（仙台市福祉プラザ）',
    lat: 38.254,
    lng: 140.8772,
    slot: ['window', '16:00', '16:30', 60],
    requiredGender: 'female',
    weekend: true,
  },
  {
    id: 'c19',
    name: '文化センター うたお',
    address: '仙台市宮城野区五輪（宮城野区文化センター）',
    lat: 38.258,
    lng: 140.911,
    slot: ['fixed', '10:30', '10:30', 60],
    note: '歌が好き',
  },
  {
    id: 'c20',
    name: '中田 みのり',
    address: '仙台市太白区中田（中田市民センター）',
    lat: 38.1985,
    lng: 140.8815,
    slot: ['window', '13:00', '15:00', 60],
    weekend: true,
  },
];
const clients: Record<string, Client & ClientPrivate> = Object.fromEntries(
  clientSeeds.map((c, i) => [
    c.id,
    {
      displayName: c.name,
      place: { address: c.address, lat: c.lat, lng: c.lng },
      requiredGender: c.requiredGender ?? null,
      ngStaffIds: c.ng ?? [],
      note: c.note ?? '',
      color: i % 8,
      active: true,
    },
  ]),
);

const until = process.env.SEED_UNTIL ?? '2026-11-30';
const isWeekend = (date: string) => weekday(date) === 0 || weekday(date) === 6;
const shiftBy = (hhmm: string, min: number) => minutesToHhmm(hhmmToMinutes(hhmm) + min);
const dates: string[] = [];
for (let d = jstDate(Date.now()); d <= until; d = addDays(d, 1)) dates.push(d);

/**
 * その日の訪問（同じ日なら毎回同じ）。平日は20か所から日ごとに3か所前後が休み、土日は印のある8か所。
 * 時間に幅のある訪問は日ごとに 0〜60分ずらす
 */
function visitsOf(date: string, n: number): (Visit & { id: string })[] {
  return clientSeeds
    .filter((c, i) => (isWeekend(date) ? c.weekend : (i + n) % 7 !== 0))
    .map((c) => {
      const [kind, e, l, mins] = c.slot;
      const d = kind === 'window' ? (n % 3) * 30 : 0;
      return {
        id: `${date}_${c.id}`,
        date,
        clientId: c.id,
        windowKind: kind,
        earliestStart: shiftBy(e, d),
        latestStart: shiftBy(l, d),
        durationMinutes: mins,
        staffId: null,
        cancelled: false,
        note: '',
      };
    })
    .sort((a, b) => a.earliestStart.localeCompare(b.earliestStart));
}

/** 手作業の割り当てで見込む移動時間（分）。実際より短く見積もりがち */
const MANUAL_TRAVEL_MIN = 30;

/**
 * 手作業らしい割り当て：時刻の早い訪問から、担当の慣れ（場所によらない順番）で空いている人に入れる。
 * 性別の希望・NG・勤務時間は守るが、近さは見ないので遠回りになる
 */
function manualRoutesOf(date: string, n: number, visits: (Visit & { id: string })[]): Record<string, string[]> {
  const working = Object.entries(staff).filter(([, s]) => s.workDays.includes(weekday(date)));
  const freeAt = new Map(working.map(([id, s]) => [id, hhmmToMinutes(s.shiftStart)]));
  const routes: Record<string, string[]> = {};
  for (const [k, v] of visits.entries()) {
    const c = clients[v.clientId];
    for (let j = 0; j < working.length; j++) {
      const [sid, s] = working[(k * 3 + n + j) % working.length] as [string, Staff];
      if (c?.requiredGender && c.requiredGender !== s.gender) continue;
      if (c?.ngStaffIds.includes(sid)) continue;
      const free = freeAt.get(sid) ?? 0;
      const start = Math.max(
        hhmmToMinutes(v.earliestStart),
        free + ((routes[sid]?.length ?? 0) > 0 ? MANUAL_TRAVEL_MIN : 0),
      );
      if (start > hhmmToMinutes(v.latestStart) || start + v.durationMinutes > hhmmToMinutes(s.shiftEnd)) continue;
      freeAt.set(sid, start + v.durationMinutes);
      routes[sid] = [...(routes[sid] ?? []), v.id];
      break;
    }
  }
  return routes;
}

// 事業所の文書を先に書く（途中で止まっても、endDemo が事業所を見つけて片付けられるように）
await db.doc(`orgs/${orgId}`).set(org);

// 実行日以降の予定と、その日のAI案を作り直す（訪問先・スタッフの入れ替えで古い訪問が残らないように）
const first = dates[0] ?? jstDate(Date.now());
const writer = db.bulkWriter();
for (const name of ['visits', 'manualPlans', 'planRuns']) {
  const old = await db.collection(`orgs/${orgId}/${name}`).where('date', '>=', first).get();
  for (const d of old.docs) writer.delete(d.ref);
}
await writer.close();

let total = 0;
for (const [n, date] of dates.entries()) {
  const batch = db.batch();
  const visits = visitsOf(date, n);
  const routes = manualRoutesOf(date, n, visits);
  const ownerOf = new Map(Object.entries(routes).flatMap(([s, ids]) => ids.map((id) => [id, s] as const)));
  for (const { id, ...v } of visits)
    batch.set(db.doc(`orgs/${orgId}/visits/${id}`), { ...v, staffId: ownerOf.get(id) ?? null });
  batch.set(db.doc(`orgs/${orgId}/manualPlans/${date}`), {
    date,
    routes,
    minutesSpent: isWeekend(date) ? 15 : 40,
    updatedBy: 'seed',
    updatedAt: Date.now(),
  });
  await batch.commit();
  total += visits.length;
}

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
console.log(
  `デモデータを入れました（事業所 demo、スタッフ ${Object.keys(staff).length}人・訪問先 ${clientSeeds.length}か所、${first}〜${until} の ${dates.length} 日分・訪問 ${total} 件）`,
);
