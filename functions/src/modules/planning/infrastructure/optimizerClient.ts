import { type SolveRequest, type SolveResponse, solveResponseSchema } from '@vrp/shared';
import { defineString } from 'firebase-functions/params';
import { HttpsError } from 'firebase-functions/v2/https';
import { GoogleAuth } from 'google-auth-library';

/** 最適化サービスのURL（デプロイ後の Cloud Run URL。ローカルは python の開発サーバー） */
export const OPTIMIZER_URL = defineString('OPTIMIZER_URL', { default: '' });

const auth = new GoogleAuth();

export async function solve(req: SolveRequest): Promise<SolveResponse> {
  const base = OPTIMIZER_URL.value();
  if (!base) throw new HttpsError('unavailable', '最適化サービスが設定されていません');
  const url = `${base.replace(/\/$/, '')}/v1/plans:solve`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // 本番は IAM 認証（呼び出し元のサービスアカウントの ID トークン）。ローカル（http://）は省略
  if (base.startsWith('https://')) {
    const client = await auth.getIdTokenClient(base);
    Object.assign(headers, await client.getRequestHeaders());
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(60000),
  }).catch(() => null);
  if (!res) throw new HttpsError('unavailable', '最適化サービスに接続できませんでした。時間をおいて再度お試しください');
  if (res.status === 400)
    throw new HttpsError('invalid-argument', '最適化の入力に問題があります（訪問の時刻や担当を確認してください）');
  if (!res.ok)
    throw new HttpsError('unavailable', '最適化サービスが一時的に使えません。時間をおいて再度お試しください');
  const parsed = solveResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new HttpsError('internal', '最適化の結果を読めませんでした');
  return parsed.data;
}
