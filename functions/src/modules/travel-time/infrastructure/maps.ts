import { createHash } from 'node:crypto';
import { hhmmToMinutes, jstHhmm, type LatLng, type TravelMode } from '@vrp/shared';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { col } from '../../../lib/context';
import { fallbackLeg, type TimeBand, timeBandOf } from '../domain/predict';
import { estimateScale, groupByOrigin, neighborPairs } from '../domain/sparse';

/** サーバー用の Maps API キー（Secret Manager）。未設定なら概算に切り替える */
export const MAPS_SERVER_KEY = defineSecret('MAPS_SERVER_KEY');

const CACHE_DAYS = 30;

function mapsKey(): string | null {
  try {
    const v = MAPS_SERVER_KEY.value();
    return v ? v : null;
  } catch {
    return null;
  }
}

export type BaseLeg = {
  seconds: number;
  meters: number;
  /** routes_api：実測（キャッシュ含む）、estimate：近傍外の概算、fallback：地図APIが使えず概算 */
  source: 'routes_api' | 'estimate' | 'fallback';
};

type CachedLeg = { seconds: number; meters: number; fetchedAt: number } | { noRoute: true; fetchedAt: number };

const round = (n: number) => n.toFixed(5);
function legHash(a: LatLng, b: LatLng, mode: TravelMode, band: TimeBand): string {
  return createHash('sha256')
    .update(`${round(a.lat)},${round(a.lng)}|${round(b.lat)},${round(b.lng)}|${mode}|${band}`)
    .digest('hex')
    .slice(0, 32);
}

/** 地図APIへの同時リクエスト数 */
const CONCURRENCY = 4;

/**
 * 地点 × 地点の基準移動時間（ADR-0004）。
 * 近傍の区間（neighborPairs）だけをキャッシュ（legCache, 30日）→ Routes API の順に引き、
 * 残りの区間は直線距離の概算を、同じ行列の実測から求めた倍率で補正して埋める。
 * キャッシュの時間区分は時間帯（朝・日中・夕方。日本時間）で、補正モデルの区分と同じ。
 * 過去の出発時刻は Routes API に渡せず「今」の交通で返るので、そのときは今の時間帯をキーにする。
 */
export async function baseMatrix(
  orgId: string,
  points: LatLng[],
  mode: TravelMode,
  departAtMs: number,
  /** 事業所の設定で地図APIを使わないときは false（すべて概算） */
  useMaps = true,
): Promise<BaseLeg[][]> {
  const band = timeBandOf(hhmmToMinutes(jstHhmm(Math.max(departAtMs, Date.now()))));
  const out: (BaseLeg | null)[][] = points.map((_, i) =>
    points.map((__, j) => (i === j ? { seconds: 0, meters: 0, source: 'routes_api' as const } : null)),
  );
  const key = useMaps ? mapsKey() : null;
  if (!key) return fillEstimates(out, points, mode, 'fallback');

  const pairs = neighborPairs(points);
  const cache = col(orgId, 'legCache');
  const hashOf = ([i, j]: [number, number]) => legHash(points[i]!, points[j]!, mode, band);
  const snaps = pairs.length ? await cache.firestore.getAll(...pairs.map((p) => cache.doc(hashOf(p)))) : [];
  const now = Date.now();
  const missing: [number, number][] = [];
  snaps.forEach((s, k) => {
    const [i, j] = pairs[k]!;
    const d = s.data() as CachedLeg | undefined;
    if (!d || now - d.fetchedAt >= CACHE_DAYS * 86400000) missing.push([i, j]);
    else if ('noRoute' in d) out[i]![j] = { ...fallbackLeg(points[i]!, points[j]!, mode), source: 'fallback' };
    else out[i]![j] = { seconds: d.seconds, meters: d.meters, source: 'routes_api' };
  });

  // 出発地ごとに、足りない到着地だけを聞く。成功したリクエストの分はすぐキャッシュに書く
  // （途中で失敗・タイムアウトしても、課金済みの結果を捨てない）
  const groups = groupByOrigin(missing);
  let failed = 0;
  for (let g = 0; g < groups.length; g += CONCURRENCY) {
    await Promise.all(
      groups.slice(g, g + CONCURRENCY).map(async ({ origin, destinations }) => {
        const fetched = await fetchRow(
          key,
          points[origin]!,
          destinations.map((j) => points[j]!),
          mode,
          departAtMs,
        ).catch((e: unknown) => {
          failed++;
          logger.warn('travel_time.routes_api_failed', { reason: e instanceof Error ? e.message : 'unknown' });
          return null;
        });
        if (!fetched) return;
        const batch = cache.firestore.batch();
        destinations.forEach((j, k) => {
          const f = fetched[k];
          if (f === 'no_route') {
            // ルートなしは覚えておき、毎回聞き直さない（要素ごとのエラーは一時的かもしれないので覚えない）
            batch.set(cache.doc(hashOf([origin, j])), { noRoute: true, fetchedAt: now });
          } else if (f) {
            out[origin]![j] = { ...f, source: 'routes_api' };
            batch.set(cache.doc(hashOf([origin, j])), { ...f, fetchedAt: now });
          }
        });
        // キャッシュに書けなくても、取得済みの結果で行列は作れるので止めない
        await batch.commit().catch((e: unknown) => {
          logger.warn('travel_time.leg_cache_write_failed', { reason: e instanceof Error ? e.name : 'unknown' });
        });
      }),
    );
  }
  if (failed) logger.warn('travel_time.routes_api_partial', { failedRequests: failed, requests: groups.length });

  // 失敗・ルートなし・要素エラーの近傍区間は fallback、近傍外は estimate で埋める
  for (const [i, j] of pairs)
    if (!out[i]![j]) out[i]![j] = { ...fallbackLeg(points[i]!, points[j]!, mode), source: 'fallback' };
  return fillEstimates(out, points, mode, 'estimate');
}

/** 空いている区間を、直線距離の概算 × 実測から求めた倍率で埋める */
function fillEstimates(
  out: (BaseLeg | null)[][],
  points: LatLng[],
  mode: TravelMode,
  source: 'estimate' | 'fallback',
): BaseLeg[][] {
  const samples: { actual: number; estimate: number }[] = [];
  for (let i = 0; i < out.length; i++)
    for (let j = 0; j < out.length; j++) {
      const l = out[i]![j];
      if (l?.source === 'routes_api' && i !== j)
        samples.push({ actual: l.seconds, estimate: fallbackLeg(points[i]!, points[j]!, mode).seconds });
    }
  const scale = estimateScale(samples);
  return out.map((row, i) =>
    row.map((l, j) => {
      if (l) return l;
      const e = fallbackLeg(points[i]!, points[j]!, mode);
      // 倍率は主に速度の差なので、距離には掛けない
      return { seconds: Math.round(e.seconds * scale), meters: e.meters, source };
    }),
  );
}

type RowElement = { seconds: number; meters: number } | 'no_route' | null;

/**
 * Routes API computeRouteMatrix（出発地1つ × 到着地の一覧）。
 * ルートが無い到着地は 'no_route'、要素ごとのエラー・応答に無い到着地は null
 */
async function fetchRow(
  key: string,
  origin: LatLng,
  destinations: LatLng[],
  mode: TravelMode,
  departAtMs: number,
): Promise<RowElement[]> {
  const out: RowElement[] = destinations.map(() => null);
  const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const body: Record<string, unknown> = {
    origins: [wp(origin)],
    destinations: destinations.map(wp),
    travelMode: mode,
  };
  if (mode === 'DRIVE') {
    body.routingPreference = 'TRAFFIC_AWARE';
    // 過去の日時は指定できないので、未来のときだけ渡す
    if (departAtMs > Date.now()) body.departureTime = new Date(departAtMs).toISOString();
  }
  const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition,status',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`routes_api_${res.status}`);
  const rows = (await res.json()) as {
    destinationIndex?: number;
    duration?: string;
    distanceMeters?: number;
    condition?: string;
    status?: { code?: number };
  }[];
  let elementErrors = 0;
  for (const r of rows) {
    const j = r.destinationIndex ?? 0;
    if (r.condition === 'ROUTE_EXISTS')
      out[j] = { seconds: Number.parseInt(r.duration ?? '0', 10), meters: r.distanceMeters ?? 0 };
    else if (r.condition === 'ROUTE_NOT_FOUND') out[j] = 'no_route';
    else elementErrors++;
  }
  if (elementErrors) logger.warn('travel_time.routes_api_element_errors', { count: elementErrors });
  return out;
}

/** 住所 → 緯度経度の候補（Geocoding API） */
export async function geocode(
  address: string,
): Promise<{ formattedAddress: string; lat: number; lng: number }[] | null> {
  const key = mapsKey();
  if (!key) return null;
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('language', 'ja');
  url.searchParams.set('region', 'jp');
  url.searchParams.set('key', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`geocode_${res.status}`);
  const json = (await res.json()) as {
    status: string;
    results: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[];
  };
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') throw new Error(`geocode_${json.status}`);
  return json.results.slice(0, 5).map((r) => ({
    formattedAddress: r.formatted_address,
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
  }));
}
