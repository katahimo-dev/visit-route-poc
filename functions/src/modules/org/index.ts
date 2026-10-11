import { createHash } from 'node:crypto';
import { geocodeAddressRequest, inviteMemberRequest, type Staff } from '@vrp/shared';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/v2';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, orgDoc, parse, REGION, requireManager } from '../../lib/context';
import { geocode, MAPS_SERVER_KEY } from '../travel-time/infrastructure/maps';
import { DEMO_ORG_ID } from './login';

/**
 * メンバーを招待する。Firebase Auth にユーザーを作り（無ければ）、事業所とロールをクレームに付ける。
 * ログインは画面からメールリンクで行う。クレームの無いユーザーは何も読めない（firestore.rules）。
 */
export const inviteMember = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const input = parse(inviteMemberRequest, req.data);
  // デモの環境では招待しない（誰でも管理者になれるので、他人のアドレスを登録させない）
  if (DEMO_ORG_ID.value() && process.env.FUNCTIONS_EMULATOR !== 'true')
    throw new HttpsError('permission-denied', 'デモでは招待できません');
  const orgId = requireManager(c, input.orgId);
  if (!(await orgDoc(orgId).get()).exists) throw new HttpsError('not-found', '事業所がありません');
  if (input.role === 'staff' && !input.staffId) throw new HttpsError('invalid-argument', 'スタッフを選んでください');
  const staffRef = input.staffId ? col(orgId, 'staff').doc(input.staffId) : null;
  const staffSnap = staffRef ? await staffRef.get() : null;
  if (staffSnap && !staffSnap.exists) throw new HttpsError('not-found', 'スタッフがいません');

  const auth = getAuth();
  const user = await auth.getUserByEmail(input.email).catch(() => auth.createUser({ email: input.email }));
  const existing = user.customClaims ?? {};
  if (existing.orgId && existing.orgId !== orgId) {
    throw new HttpsError('failed-precondition', 'このメールアドレスは他の事業所で使用されています');
  }
  if (existing.role === 'operator') throw new HttpsError('failed-precondition', 'このメールアドレスには設定できません');
  await auth.setCustomUserClaims(user.uid, {
    orgId,
    role: input.role,
    ...(input.role === 'staff' ? { staffId: input.staffId } : {}),
  });
  if (staffRef) {
    // 別の人に付け替えるときは、前の人のクレームを外してログインを切る（onStaffUpdated でも外す）
    const prevUid = (staffSnap?.data() as Staff | undefined)?.uid ?? null;
    await staffRef.update({ uid: user.uid });
    if (prevUid && prevUid !== user.uid) await revokeMember(prevUid, orgId, staffRef.id);
  }
  logger.info('org.member_invited', { orgId, uid: user.uid, role: input.role });
  return { uid: user.uid };
});

/**
 * メンバーのクレームを外し、リフレッシュトークンを無効にする（退職・付け替え）。
 * すでに発行済みの ID トークン（最長1時間）は firestore.rules がスタッフ文書の active と uid で止める。
 */
async function revokeMember(uid: string, orgId: string, staffId: string): Promise<void> {
  const auth = getAuth();
  const user = await auth.getUser(uid).catch(() => null);
  // すでに別のスタッフに付け替え済みの人（クレームの staffId が違う）は外さない
  const claims = user?.customClaims;
  if (!user || claims?.orgId !== orgId || claims?.role !== 'staff' || claims?.staffId !== staffId) return;
  await auth.setCustomUserClaims(uid, null);
  await auth.revokeRefreshTokens(uid);
  logger.info('org.member_revoked', { orgId, uid });
}

/**
 * スタッフを休止にした（active が false に変わった）・uid を付け替えたら、そのアカウントのログインを切る。
 * 休止のままの編集では切らない（休止中に招待し直した人を、続く編集で切らないため）
 */
export const onStaffUpdated = onDocumentUpdated(
  { document: 'orgs/{orgId}/staff/{staffId}', region: REGION },
  async (e) => {
    const before = e.data?.before.data() as Staff | undefined;
    const after = e.data?.after.data() as Staff | undefined;
    const uid = before?.uid;
    if (!uid) return;
    const deactivated = before?.active !== false && after?.active === false;
    if (deactivated || after?.uid !== uid) await revokeMember(uid, e.params.orgId, e.params.staffId);
  },
);

const GEOCODE_CACHE_DAYS = 30;

/** 住所 → 緯度経度の候補。保存は画面（管理者）が行う。同じ住所は30日間キャッシュから返す（地図APIの課金を抑える） */
export const geocodeAddress = onCall({ region: REGION, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  const { address } = parse(geocodeAddressRequest, req.data);
  const orgId = requireManager(callerOf(req), (req.data as { orgId?: string } | null)?.orgId ?? null);
  const cacheRef = col(orgId, 'geocodeCache').doc(
    createHash('sha256').update(address.trim()).digest('hex').slice(0, 32),
  );
  const cached = (await cacheRef.get()).data() as { candidates: unknown[]; fetchedAt: number } | undefined;
  if (cached && Date.now() - cached.fetchedAt < GEOCODE_CACHE_DAYS * 86400000) return { candidates: cached.candidates };
  const candidates = await geocode(address).catch(() => {
    throw new HttpsError('unavailable', '住所の変換に失敗しました。地図でピンを動かして位置を決めてください');
  });
  if (candidates === null)
    throw new HttpsError('unavailable', '住所の変換は設定されていません。地図でピンを動かして位置を決めてください');
  await cacheRef.set({ candidates, fetchedAt: Date.now() });
  return { candidates };
});

export {
  DEMO_ORG_ID,
  demoSignIn,
  demoStaffList,
  requestLoginCode,
  revokeInactiveSessions,
  verifyLoginCode,
} from './login';
