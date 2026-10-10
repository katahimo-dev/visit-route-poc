/**
 * エミュレーターでの通し確認（デモデータ投入後に実行）。
 *   pnpm smoke
 * 管理者として AI案を作り、スタッフとして はじめる/おわる を記録し、勤怠候補・実測区間ができることを確かめる。
 */
import { addDays, jstDate, jstToMs } from '@vrp/shared';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, setDoc } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { getFirestore as adminDb } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
initAdmin({ projectId: 'demo-visit-route' });
const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-visit-route', appId: 'demo' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);
const fns = getFunctions(app, 'asia-northeast1');
connectFunctionsEmulator(fns, '127.0.0.1', 5001);

async function signIn(email: string) {
  const u = await adminAuth().getUserByEmail(email);
  await signInWithCustomToken(auth, await adminAuth().createCustomToken(u.uid, u.customClaims));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed = true;
};

const today = jstDate(Date.now());
const tomorrow = addDays(today, 1);

// 1. 管理者：あしたのAI案
await signIn('admin@example.com');
const run = await httpsCallable<unknown, { runId: string }>(
  fns,
  'createPlanRun',
)({ date: tomorrow, requestId: `smoke-${Date.now()}` });
const runDoc = (await adminDb().doc(`orgs/demo/planRuns/${run.data.runId}`).get()).data();
check(!!runDoc, 'AI案が planRuns に保存された');
const m = runDoc?.metrics;
console.log(
  `  手作業 ${Math.round(m.manual.travelSeconds / 60)}分 / AI ${Math.round(m.ai.travelSeconds / 60)}分、違反 ${m.manual.violations}→${m.ai.violations}、未割当 ${runDoc?.result.unassigned.length}、モデル ${runDoc?.modelVersion}`,
);
check(m.ai.violations === 0, 'AI案は条件違反なし');
check(m.ai.travelSeconds <= m.manual.travelSeconds, 'AI案の移動時間は手作業以下');
await signOut(auth);

// 2. スタッフ：きょうの1件目・2件目を はじめる/おわる（オフライン再送は同じIDで2回書いても1件）
await signIn('staff1@example.com');
const ev = (id: string, type: string, visitId: string, hhmm: string) =>
  setDoc(doc(db, 'orgs/demo/events', id), {
    staffId: 's1',
    date: today,
    type,
    visitId,
    source: 'button',
    clientTime: jstToMs(today, hhmm),
    lat: null,
    lng: null,
    accuracy: null,
  });
const v1 = `${today}_v1`;
const v2 = `${today}_v2`;
await ev('e1', 'arrive', v1, '08:55');
await ev('e2', 'service_start', v1, '09:00');
await ev('e3', 'service_end', v1, '10:00');
await ev('e4', 'depart', v1, '10:03');
await ev('e5', 'arrive', v2, '10:40');
await ev('e6', 'service_start', v2, '10:45');
await ev('e7', 'service_end', v2, '11:30');
let retryFailed = false;
await ev('e7', 'service_end', v2, '11:30').catch(() => {
  retryFailed = true;
});
check(retryFailed, '同じ記録の再送は上書きされない（ルールで拒否＝二重登録なし）');
await sleep(4000);
const day = (await adminDb().doc(`orgs/demo/attendanceDays/s1_${today}`).get()).data();
check(!!day, '勤怠候補ができた');
console.log(
  `  実働 ${day?.totals.workMinutes}分 / 移動 ${day?.totals.travelMinutes}分 / 休憩 ${day?.totals.breakMinutes}分 / 拘束 ${day?.totals.boundMinutes}分`,
);
check(day?.totals.workMinutes === 105, '実働 105分');
const legs = await adminDb()
  .collection('orgs/demo/legActuals')
  .where('staffId', '==', 's1')
  .where('date', '==', today)
  .get();
check(legs.size === 1, '実測区間（予測値つき）が1件保存された');
console.log(`  実測 ${legs.docs[0]?.data().actualSeconds}秒 / 予測 ${legs.docs[0]?.data().predictedSeconds}秒`);

// 3. スタッフ：確認 → 管理者：承認 → CSV
const confirmed = await httpsCallable<unknown, { version: number }>(
  fns,
  'confirmAttendance',
)({ date: today, version: day?.version });
await signOut(auth);
await signIn('admin@example.com');
await httpsCallable(
  fns,
  'approveAttendance',
)({ staffId: 's1', date: today, version: confirmed.data.version, orgId: null });
const csv = await httpsCallable<unknown, { files: { name: string; csv: string }[] }>(
  fns,
  'exportAttendanceCsv',
)({ month: today.slice(0, 7), orgId: null });
check(csv.data.files[1]?.csv.includes('approved') ?? false, '承認して勤怠CSVに出た');
await signOut(auth);

// 4. 運営者：実証データCSV（仮名ID）
await signIn('operator@example.com');
const study = await httpsCallable<unknown, { files: { name: string; csv: string }[] }>(
  fns,
  'exportStudyData',
)({ orgId: 'demo', from: today, to: tomorrow });
const all = study.data.files.map((f) => f.csv).join('\n');
check(
  study.data.files.length === 3 && !all.includes('市役所') && !all.includes('s1,'),
  '実証データCSVに氏名・元のIDが出ない',
);
process.exit(failed ? 1 : 0);
