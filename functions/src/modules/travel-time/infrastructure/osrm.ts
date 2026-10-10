import type { LatLng, TravelMode } from '@vrp/shared';
import { defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { GoogleAuth } from 'google-auth-library';
import { osrmRouteUrl, osrmSupports, parseOsrmRoute } from '../domain/osrm';

/** OSRM 仙台版の URL（Cloud Run、IAM 認証）。未設定なら比較値を残さない */
export const OSRM_URL = defineString('OSRM_URL', { default: '' });

const auth = new GoogleAuth();

/** OSRM の区間の移動時間（比較用）。未設定・非対応の移動手段・失敗のときは null（本処理を止めない） */
export async function osrmLeg(
  a: LatLng,
  b: LatLng,
  mode: TravelMode,
): Promise<{ seconds: number; meters: number } | null> {
  const base = OSRM_URL.value();
  if (!base || !osrmSupports(mode)) return null;
  try {
    // 本番は IAM 認証（呼び出し元のサービスアカウントの ID トークン）。ローカル（http://）は省略
    const headers = base.startsWith('https://')
      ? await (await auth.getIdTokenClient(base)).getRequestHeaders()
      : new Headers();
    // 最小0インスタンスなので、コールドスタート（データの読み込み）を見込んで長めに待つ
    const res = await fetch(osrmRouteUrl(base, a, b), { headers, signal: AbortSignal.timeout(15000) });
    // ルートなしは 400（code: NoRoute）で返るので、本文を見て判断する
    return parseOsrmRoute(await res.json());
  } catch (e) {
    logger.warn('travel_time.osrm_failed', { reason: e instanceof Error ? e.name : 'unknown' });
    return null;
  }
}
