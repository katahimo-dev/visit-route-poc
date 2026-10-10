import { geocodeAddressRequest, inviteMemberRequest } from '@vrp/shared';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, orgDoc, parse, REGION, requireManager } from '../../lib/context';
import { geocode, MAPS_SERVER_KEY } from '../travel-time/infrastructure/maps';

/**
 * メンバーを招待する。Firebase Auth にユーザーを作り（無ければ）、事業所とロールをクレームに付ける。
 * ログインは画面からメールリンクで行う。クレームの無いユーザーは何も読めない（firestore.rules）。
 */
export const inviteMember = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const input = parse(inviteMemberRequest, req.data);
  const orgId = requireManager(c, input.orgId);
  if (!(await orgDoc(orgId).get()).exists) throw new HttpsError('not-found', '事業所がありません');
  if (input.role === 'staff' && !input.staffId) throw new HttpsError('invalid-argument', 'スタッフを選んでください');
  const staffRef = input.staffId ? col(orgId, 'staff').doc(input.staffId) : null;
  if (staffRef && !(await staffRef.get()).exists) throw new HttpsError('not-found', 'スタッフがいません');

  const auth = getAuth();
  const user = await auth.getUserByEmail(input.email).catch(() => auth.createUser({ email: input.email }));
  const existing = user.customClaims ?? {};
  if (existing.orgId && existing.orgId !== orgId) {
    throw new HttpsError('failed-precondition', 'このメールアドレスはほかの事業所で使われています');
  }
  if (existing.role === 'operator') throw new HttpsError('failed-precondition', 'このメールアドレスには設定できません');
  await auth.setCustomUserClaims(user.uid, {
    orgId,
    role: input.role,
    ...(input.role === 'staff' ? { staffId: input.staffId } : {}),
  });
  if (staffRef) await staffRef.update({ uid: user.uid });
  logger.info('org.member_invited', { orgId, uid: user.uid, role: input.role });
  return { uid: user.uid };
});

/** 住所 → 緯度経度の候補。保存は画面（管理者）が行う */
export const geocodeAddress = onCall({ region: REGION, secrets: [MAPS_SERVER_KEY] }, async (req) => {
  requireManager(callerOf(req), (req.data as { orgId?: string } | null)?.orgId ?? null);
  const { address } = parse(geocodeAddressRequest, req.data);
  const candidates = await geocode(address).catch(() => {
    throw new HttpsError('unavailable', '住所の変換に失敗しました。地図でピンを動かして位置を決めてください');
  });
  if (candidates === null)
    throw new HttpsError('unavailable', '住所の変換は設定されていません。地図でピンを動かして位置を決めてください');
  return { candidates };
});
