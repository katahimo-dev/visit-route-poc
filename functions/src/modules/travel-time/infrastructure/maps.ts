import { createHash } from 'node:crypto';
import type { LatLng, TravelMode } from '@vrp/shared';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { col } from '../../../lib/context';
import { fallbackLeg } from '../domain/predict';

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

export type BaseLeg = { seconds: number; meters: number; source: 'routes_api' | 'fallback' };

const round = (n: number) => n.toFixed(5);
function legHash(a: LatLng, b: LatLng, mode: TravelMode, departHour: number): string {
  return createHash('sha256')
    .update(`${round(a.lat)},${round(a.lng)}|${round(b.lat)},${round(b.lng)}|${mode}|${departHour}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 地点 × 地点の基準移動時間。キャッシュ（legCache, 30日）→ Routes API の順に引く。
 * departHour は「何時台に出発するか」（交通の混み具合を反映させるため、実際の出発日時の目安に使う）。
 */
export async function baseMatrix(
  orgId: string,
  points: LatLng[],
  mode: TravelMode,
  departAtMs: number,
): Promise<BaseLeg[][]> {
  const hour = new Date(departAtMs).getUTCHours();
  const n = points.length;
  const out: (BaseLeg | null)[][] = points.map((_, i) =>
    points.map((__, j) => (i === j ? { seconds: 0, meters: 0, source: 'fallback' as const } : null)),
  );
  const key = mapsKey();
  if (!key) {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (!out[i]![j]) out[i]![j] = { ...fallbackLeg(points[i]!, points[j]!, mode), source: 'fallback' };
    return out as BaseLeg[][];
  }
  // キャッシュ
  const cache = col(orgId, 'legCache');
  const missing: [number, number][] = [];
  const hashes: string[][] = points.map((a, i) => points.map((b, j) => (i === j ? '' : legHash(a, b, mode, hour))));
  const refs: { i: number; j: number; ref: FirebaseFirestore.DocumentReference }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (i !== j) refs.push({ i, j, ref: cache.doc(hashes[i]![j]!) });
  const snaps = refs.length ? await cache.firestore.getAll(...refs.map((r) => r.ref)) : [];
  const now = Date.now();
  snaps.forEach((s, k) => {
    const { i, j } = refs[k]!;
    const d = s.data() as { seconds: number; meters: number; fetchedAt: number } | undefined;
    if (d && now - d.fetchedAt < CACHE_DAYS * 86400000)
      out[i]![j] = { seconds: d.seconds, meters: d.meters, source: 'routes_api' };
    else missing.push([i, j]);
  });
  if (missing.length) {
    const fetched = await fetchRouteMatrix(key, points, mode, departAtMs).catch((e: unknown) => {
      logger.warn('travel_time.routes_api_failed', { reason: e instanceof Error ? e.name : 'unknown' });
      return null;
    });
    const batch = cache.firestore.batch();
    for (const [i, j] of missing) {
      const f = fetched?.[i]?.[j];
      if (f) {
        out[i]![j] = { ...f, source: 'routes_api' };
        batch.set(cache.doc(hashes[i]![j]!), { ...f, fetchedAt: now });
      } else {
        out[i]![j] = { ...fallbackLeg(points[i]!, points[j]!, mode), source: 'fallback' };
      }
    }
    if (fetched) await batch.commit();
  }
  return out as BaseLeg[][];
}

/** Routes API computeRouteMatrix（1回あたり最大625要素。超える分は分割） */
async function fetchRouteMatrix(
  key: string,
  points: LatLng[],
  mode: TravelMode,
  departAtMs: number,
): Promise<({ seconds: number; meters: number } | null)[][]> {
  const n = points.length;
  const out: ({ seconds: number; meters: number } | null)[][] = points.map(() => points.map(() => null));
  const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const chunk = Math.max(1, Math.floor(625 / n));
  for (let o = 0; o < n; o += chunk) {
    const origins = points.slice(o, o + chunk);
    const body: Record<string, unknown> = {
      origins: origins.map(wp),
      destinations: points.map(wp),
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
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`routes_api_${res.status}`);
    const rows = (await res.json()) as {
      originIndex?: number;
      destinationIndex?: number;
      duration?: string;
      distanceMeters?: number;
      condition?: string;
    }[];
    for (const r of rows) {
      if (r.condition !== 'ROUTE_EXISTS') continue;
      const i = o + (r.originIndex ?? 0);
      const j = r.destinationIndex ?? 0;
      out[i]![j] = { seconds: Number.parseInt(r.duration ?? '0', 10), meters: r.distanceMeters ?? 0 };
    }
  }
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
