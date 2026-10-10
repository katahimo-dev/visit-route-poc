/**
 * デモ期間の片付け（本番＝実データでの検証に切り替える前に1回だけ実行する）。
 *   GCLOUD_PROJECT=<プロジェクトID> pnpm tsx scripts/endDemo.ts          … 消す対象を表示するだけ
 *   GCLOUD_PROJECT=<プロジェクトID> pnpm tsx scripts/endDemo.ts --apply  … 実際に消す
 * 消すもの：デモの印のある事業所（orgs/{id} と配下すべて）と、そこに属するアカウント・デモ用アカウント・
 * seedDemo が作った @example.com のアカウント。実データの事業所（印が無い）には触れない。
 * このあと functions/.env.<project> の DEMO_ORG_ID と、画面の VITE_DEMO_LOGIN を外してデプロイする（README）。
 */
import type { Org } from '@vrp/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const apply = process.argv.includes('--apply');
if (getApps().length === 0)
  initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? 'demo-visit-route' });
const db = getFirestore();
const auth = getAuth();

const orgs = await db.collection('orgs').get();
const demoOrgIds = orgs.docs.filter((d) => (d.data() as Org).demo === true).map((d) => d.id);
const realOrgIds = orgs.docs.filter((d) => (d.data() as Org).demo !== true).map((d) => d.id);

const users: UserRecord[] = [];
let pageToken: string | undefined;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    const orgId = u.customClaims?.orgId;
    const demoUser =
      u.uid.startsWith('demo-') ||
      (typeof orgId === 'string' && demoOrgIds.includes(orgId)) ||
      (u.email?.endsWith('@example.com') ?? false);
    if (demoUser) users.push(u);
  }
  pageToken = page.pageToken;
} while (pageToken);

console.log(
  `デモの事業所：${demoOrgIds.join(', ') || 'なし'}（残す実データの事業所：${realOrgIds.join(', ') || 'なし'}）`,
);
console.log(`消すアカウント：${users.length} 件`);
for (const u of users) console.log(`  ${u.uid} ${u.email ?? ''} ${JSON.stringify(u.customClaims ?? {})}`);

if (!apply) {
  console.log('確認だけです。消すときは --apply を付けて実行してください');
  process.exit(0);
}
for (const id of demoOrgIds) await db.recursiveDelete(db.doc(`orgs/${id}`));
for (let i = 0; i < users.length; i += 1000) await auth.deleteUsers(users.slice(i, i + 1000).map((u) => u.uid));
console.log('片付けました');
process.exit(0);
