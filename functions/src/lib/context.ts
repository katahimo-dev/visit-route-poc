import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { z } from 'zod';

if (getApps().length === 0) initializeApp();
// 連打・不具合・乗っ取られたアカウントで関数が際限なく増えて課金されないよう、全関数の同時インスタンス数に天井を設ける
setGlobalOptions({ maxInstances: 10 });
export const db = getFirestore();
export const REGION = 'asia-northeast1';

export type Caller = { uid: string; role: 'operator' | 'admin' | 'staff'; orgId: string | null; staffId: string | null };

/** 認証トークンのクレームから呼び出し元を取り出す。リクエストの値は信用しない */
export function callerOf(req: CallableRequest<unknown>): Caller {
  const token = req.auth?.token;
  if (!req.auth || !token) throw new HttpsError('unauthenticated', 'ログインしてください');
  const role = token.role;
  if (role !== 'operator' && role !== 'admin' && role !== 'staff') {
    throw new HttpsError('permission-denied', 'この操作はできません');
  }
  return {
    uid: req.auth.uid,
    role,
    orgId: typeof token.orgId === 'string' ? token.orgId : null,
    staffId: typeof token.staffId === 'string' ? token.staffId : null,
  };
}

/** 管理者（自分の事業所）または運営者（orgId 指定）だけ通す。対象の orgId を返す */
export function requireManager(c: Caller, requestedOrgId: string | null = null): string {
  if (c.role === 'operator') {
    const orgId = requestedOrgId ?? c.orgId;
    if (!orgId) throw new HttpsError('invalid-argument', '事業所を指定してください');
    return orgId;
  }
  if (c.role === 'admin' && c.orgId) return c.orgId;
  throw new HttpsError('permission-denied', 'この操作は管理者だけができます');
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
    throw new HttpsError('invalid-argument', '入力を確認してください', { fields });
  }
  return r.data;
}

export const orgDoc = (orgId: string) => db.doc(`orgs/${orgId}`);
export const col = (orgId: string, name: string) => db.collection(`orgs/${orgId}/${name}`);
