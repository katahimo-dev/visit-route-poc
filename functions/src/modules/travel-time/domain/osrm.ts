import type { LatLng, TravelMode } from '@vrp/shared';

/**
 * OSRM（OpenStreetMap の経路エンジン、自前の Cloud Run）の入出力。比較用（ADR-0005）。
 * 仙台版は車（car プロファイル）だけを用意するので、DRIVE 以外は聞かない。
 */

export function osrmSupports(mode: TravelMode): boolean {
  return mode === 'DRIVE';
}

/** 2地点の経路を聞く URL（OSRM は経度,緯度の順） */
export function osrmRouteUrl(base: string, a: LatLng, b: LatLng): string {
  const p = (x: LatLng) => `${x.lng.toFixed(6)},${x.lat.toFixed(6)}`;
  return `${base.replace(/\/$/, '')}/route/v1/driving/${p(a)};${p(b)}?overview=false&alternatives=false&steps=false`;
}

/** 応答から秒・メートルを取り出す。ルートなし・形が違うときは null */
export function parseOsrmRoute(json: unknown): { seconds: number; meters: number } | null {
  const j = json as { code?: unknown; routes?: { duration?: unknown; distance?: unknown }[] } | null;
  const r = j?.code === 'Ok' ? j.routes?.[0] : undefined;
  if (!r || typeof r.duration !== 'number' || typeof r.distance !== 'number') return null;
  return { seconds: Math.round(r.duration), meters: Math.round(r.distance) };
}
