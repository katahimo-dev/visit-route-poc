import type { LatLng } from '../contracts/documents';

/** 2点間の大円距離（m） */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type GeofenceState = 'inside' | 'outside' | 'unknown';

/**
 * ジオフェンスの判定。精度が悪い位置（半径の2倍超）は判定しない。
 * 出入りのばたつきを防ぐため、外に出たとみなすのは半径の1.5倍を超えたとき。
 */
export function geofenceState(
  pos: LatLng & { accuracy: number },
  center: LatLng,
  radiusMeters: number,
  previous: GeofenceState,
): GeofenceState {
  if (pos.accuracy > radiusMeters * 2) return previous;
  const d = distanceMeters(pos, center);
  if (d <= radiusMeters) return 'inside';
  if (previous === 'inside' && d <= radiusMeters * 1.5) return 'inside';
  return 'outside';
}

/** 移動手段ごとの平均速度（km/h）。地図APIが使えないときの概算に使う */
const SPEED_KMH: Record<'DRIVE' | 'BICYCLE' | 'WALK' | 'TRANSIT', number> = {
  DRIVE: 25,
  BICYCLE: 12,
  WALK: 4.5,
  TRANSIT: 15,
};

/** 直線距離 × 1.3（道なり係数）を平均速度で割った概算の移動時間 */
export function estimateLeg(
  a: LatLng,
  b: LatLng,
  mode: 'DRIVE' | 'BICYCLE' | 'WALK' | 'TRANSIT',
): { seconds: number; meters: number } {
  const meters = Math.round(distanceMeters(a, b) * 1.3);
  return { seconds: Math.round((meters / 1000 / SPEED_KMH[mode]) * 3600), meters };
}
