/**
 * 事業所の開設（運営者用。画面は作らない：PRD §9）。
 *   pnpm tsx scripts/createOrg.ts <orgId> <事業所名> <業種 sitter|care|nursing|other> <管理者メール> [--operator <運営者メール>]
 * 本番は GOOGLE_APPLICATION_CREDENTIALS か gcloud の ADC で実行する。エミュレーターは FIRESTORE_EMULATOR_HOST 等を設定する。
 */
import { DEFAULT_TERMS, INDUSTRIES, type Industry, type Org, orgSchema } from '@vrp/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2).filter((a) => a !== '--');
const opIdx = args.indexOf('--operator');
const operatorEmail = opIdx >= 0 ? args[opIdx + 1] : undefined;
const [orgId, name, industry, adminEmail] = opIdx >= 0 ? args.slice(0, opIdx) : args;
if (!orgId || !name || !industry || !adminEmail || !INDUSTRIES.includes(industry as Industry)) {
  console.error(
    '使い方: createOrg.ts <orgId> <事業所名> <sitter|care|nursing|other> <管理者メール> [--operator <メール>]',
  );
  process.exit(1);
}

if (getApps().length === 0)
  initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? 'demo-visit-route' });
const db = getFirestore();
const auth = getAuth();

const org: Org = orgSchema.parse({
  name,
  industry,
  terms: DEFAULT_TERMS[industry as Industry],
  optimizeMode: industry === 'care' ? 'assign_and_order' : 'order_only',
  geofenceMeters: 100,
  showAiToStaff: false,
  fareYenPerKm: 10,
});

async function userWithClaims(email: string, claims: Record<string, string>) {
  const user = await auth.getUserByEmail(email).catch(() => auth.createUser({ email }));
  await auth.setCustomUserClaims(user.uid, claims);
  return user.uid;
}

const ref = db.doc(`orgs/${orgId}`);
if ((await ref.get()).exists) {
  console.log(`事業所 ${orgId} は既にあります（設定は変更しません）`);
} else {
  await ref.set(org);
  console.log(`事業所 ${orgId}（${name}）を作りました`);
}
await userWithClaims(adminEmail, { orgId, role: 'admin' });
console.log(`管理者 ${adminEmail} を設定しました`);
if (operatorEmail) {
  await userWithClaims(operatorEmail, { role: 'operator' });
  console.log(`運営者 ${operatorEmail} を設定しました`);
}
