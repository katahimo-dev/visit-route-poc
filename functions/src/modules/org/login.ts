import { demoSignInRequest, requestLoginCodeRequest, type Staff, verifyLoginCodeRequest } from '@vrp/shared';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import { defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { col, db, orgDoc, parse, REGION } from '../../lib/context';
import {
  canSend,
  failed,
  issue,
  type LoginCodeDoc,
  loginCodeId,
  MAX_ATTEMPTS,
  newCode,
  shouldRevoke,
  verify,
} from './domain/login';

/**
 * ログイン（ADR-0007）。メールに6桁のコードを送り、アプリで入力してもらう（PWA から出ずにログインできる）。
 * コードは loginCodes/{メールのハッシュ}、送信は mail コレクション（Firebase 拡張機能 Trigger Email が送る）。
 * どちらも業務関数だけが読み書きする（firestore.rules で画面からは不可）。
 */

/** デモの事業所（設定した環境だけ。本番の事業所には設定しない） */
export const DEMO_ORG_ID = defineString('DEMO_ORG_ID', { default: '' });

const codes = () => db.collection('loginCodes');
const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
/** デモの環境か（プロジェクト ID に demo を含む。seedDemo と同じ守り） */
const isDemoProject = () => (process.env.GCLOUD_PROJECT ?? '').includes('demo');
/**
 * 消す日時（Firestore の TTL ポリシーで消える。README）。
 * コードの文書は送信・間違いの履歴を24時間使うので1日、メールは送り終わった後に残さないよう1日
 */
const expireAt = () => Timestamp.fromMillis(Date.now() + 86400_000);
/** 応答までの最低の時間。招待の有無・送信の上限で応答時間が変わらないようにする */
const MIN_RESPONSE_MS = 800;
const pad = async (started: number) => {
  const rest = MIN_RESPONSE_MS - (Date.now() - started);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
};

/** 招待済み（事業所のクレームがある）なら uid */
async function invitedUid(email: string): Promise<string | null> {
  const user = await getAuth()
    .getUserByEmail(email)
    .catch(() => null);
  const role = user?.customClaims?.role;
  return user && !user.disabled && (role === 'staff' || role === 'admin' || role === 'operator') ? user.uid : null;
}

/**
 * 6桁のコードをメールで送る。招待されていない・送信の上限に当たったときも、同じ応答・同じくらいの時間で返す
 * （登録の有無を探らせない）。デモの事業所を置いた環境では送らない（迷惑メールの踏み台にしない。エミュレーターは除く）。
 */
export const requestLoginCode = onCall({ region: REGION }, async (req) => {
  const started = Date.now();
  const { email } = parse(requestLoginCodeRequest, req.data);
  if ((DEMO_ORG_ID.value() && !isEmulator) || !(await invitedUid(email))) {
    await pad(started);
    return { sent: true as const };
  }
  const ref = codes().doc(loginCodeId(email));
  const code = newCode();
  const ok = await db.runTransaction(async (tx) => {
    const prev = (await tx.get(ref)).data() as LoginCodeDoc | undefined;
    const now = Date.now();
    if (!canSend(prev ?? null, now)) return false;
    tx.set(ref, { ...issue(prev ?? null, code, now), expireAt: expireAt() });
    tx.set(db.collection('mail').doc(), {
      to: email,
      expireAt: expireAt(),
      message: {
        // 件名にはコードを入れない（ロック画面の通知に出るため）
        subject: '訪問ルートのログインコード',
        text: [
          `訪問ルートのログインコードは ${code} です。`,
          'アプリの画面に入力してください。10分間有効です。',
          '',
          'このコードは誰にも教えないでください。事業所の人が電話などで聞くことはありません。',
          'ログインしようとしていない場合は、このメールを捨ててください。',
        ].join('\n'),
      },
    });
    return true;
  });
  // エミュレーターではメールが届かないので、ログで確かめられるようにする（本番では出さない）
  if (ok && isEmulator) logger.info(`[emulator] ログインコード ${email}: ${code}`);
  await pad(started);
  return { sent: true as const };
});

/** コードを確かめてログイン用のトークンを返す。5回間違えたらそのコードは使えない */
export const verifyLoginCode = onCall({ region: REGION }, async (req) => {
  const { email, code } = parse(verifyLoginCodeRequest, req.data);
  const ref = codes().doc(loginCodeId(email));
  const result = await db.runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data() as LoginCodeDoc | undefined;
    const now = Date.now();
    const r = verify(doc ?? null, code, now);
    // 使ったコードは無効にする（送信・間違いの履歴は残す）
    if (r === 'ok') tx.update(ref, { expiresAt: 0 });
    else if (r === 'wrong' && doc) tx.update(ref, failed(doc, now));
    return { r, left: doc ? MAX_ATTEMPTS - doc.attempts - 1 : 0 };
  });
  if (result.r === 'expired')
    throw new HttpsError('failed-precondition', 'コードの期限が切れました。もう一度コードを送ってください');
  if (result.r === 'wrong') {
    throw new HttpsError(
      'invalid-argument',
      result.left > 0 ? `コードが違います（あと${result.left}回）` : 'コードが違います。もう一度コードを送ってください',
    );
  }
  const uid = await invitedUid(email);
  if (!uid) throw new HttpsError('permission-denied', 'このメールアドレスではログインできません');
  return { token: await getAuth().createCustomToken(uid) };
});

/**
 * 使っていないアカウントのログインの継続を切る（毎晩）。スタッフは14日、管理者・運営者は3日。
 * 切られた人は、次にアプリを開くとログイン画面になる。
 */
export const revokeInactiveSessions = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Asia/Tokyo', region: REGION, timeoutSeconds: 540 },
  async () => {
    const auth = getAuth();
    const now = Date.now();
    let revoked = 0;
    let pageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, pageToken);
      for (const u of page.users) {
        const last = u.metadata.lastRefreshTime ?? u.metadata.lastSignInTime;
        const lastActiveMs = last ? Date.parse(last) : null;
        const tokensValidAfterMs = u.tokensValidAfterTime ? Date.parse(u.tokensValidAfterTime) : null;
        if (shouldRevoke({ role: u.customClaims?.role, lastActiveMs, tokensValidAfterMs, now })) {
          await auth.revokeRefreshTokens(u.uid);
          revoked++;
        }
      }
      pageToken = page.pageToken;
    } while (pageToken);
    logger.info('org.inactive_sessions_revoked', { revoked });
  },
);

/**
 * デモ用のログイン。メール不要で、デモの事業所の管理者か最初のスタッフとしてログインする。
 * 画面説明・お試し用。デモの事業所は架空のデータだけを置き、本番とは別のプロジェクトで動かす（ADR-0007）。
 */
export const demoSignIn = onCall({ region: REGION }, async (req) => {
  const orgId = DEMO_ORG_ID.value();
  // 設定の誤り（本番に DEMO_ORG_ID を書いた等）で本番の事業所に入れないよう、プロジェクト ID でも確かめる
  if (!orgId || !isDemoProject()) throw new HttpsError('permission-denied', 'デモは使えません');
  const { as } = parse(demoSignInRequest, req.data);
  if (!(await orgDoc(orgId).get()).exists) throw new HttpsError('not-found', 'デモの事業所がありません');
  const auth = getAuth();
  const ensure = async (uid: string, claims: Record<string, string>) => {
    await auth.getUser(uid).catch(() => auth.createUser({ uid, displayName: 'デモ' }));
    await auth.setCustomUserClaims(uid, claims);
  };
  if (as === 'admin') {
    const uid = `demo-admin-${orgId}`;
    await ensure(uid, { orgId, role: 'admin' });
    return { token: await auth.createCustomToken(uid) };
  }
  const staffSnap = await col(orgId, 'staff').where('active', '==', true).orderBy('__name__').limit(1).get();
  const staff = staffSnap.docs[0];
  if (!staff) throw new HttpsError('not-found', 'デモのスタッフがいません');
  // 実在のアカウントのクレームを書き換えないよう、常にデモ用のアカウントを使い、スタッフに紐づけ直す
  const uid = `demo-staff-${orgId}-${staff.id}`;
  await ensure(uid, { orgId, role: 'staff', staffId: staff.id });
  if ((staff.data() as Staff).uid !== uid) await staff.ref.update({ uid });
  return { token: await auth.createCustomToken(uid) };
});
