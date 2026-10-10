import { distanceMeters, type GeofenceState, geofenceState, jstDate } from '@vrp/shared';
import { addDoc, collection } from 'firebase/firestore';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { db } from '../../lib/firebase';
import { useSession } from '../../lib/session';
import { recordEvent } from './recordEvent';
import type { StaffStop } from './useStaffDay';

/**
 * 勤務中だけ位置を計測し、訪問先のジオフェンスで到着・退出を記録する（ADR-0002）。
 * PWA なので、アプリを開いている間だけ計測できる。
 */

const SAMPLE_MIN_INTERVAL_MS = 60_000;
const SAMPLE_MIN_MOVE_M = 100;

type TrackerState = { tracking: boolean; error: string | null; lastAccuracy: number | null };
const Ctx = createContext<TrackerState>({ tracking: false, error: null, lastAccuracy: null });
export const useTracker = () => useContext(Ctx);

export function ShiftTracker({
  onShift,
  stops,
  children,
}: {
  onShift: boolean;
  stops: StaffStop[];
  children: ReactNode;
}) {
  const s = useSession();
  const [state, setState] = useState<TrackerState>({ tracking: false, error: null, lastAccuracy: null });
  const fences = useRef(new Map<string, GeofenceState>());
  const lastSample = useRef<{ t: number; lat: number; lng: number } | null>(null);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const radius = s.org?.geofenceMeters ?? 100;

  useEffect(() => {
    if (!onShift || !s.orgId || !s.staffId || !('geolocation' in navigator)) {
      setState((p) => ({ ...p, tracking: false }));
      return;
    }
    const orgId = s.orgId;
    const staffId = s.staffId;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        const date = jstDate(Date.now());
        setState({ tracking: true, error: null, lastAccuracy: Math.round(p.accuracy) });
        // 位置の保存は間引く（1分以上かつ100m以上動いたとき）
        const last = lastSample.current;
        if (!last || (Date.now() - last.t >= SAMPLE_MIN_INTERVAL_MS && distanceMeters(last, p) >= SAMPLE_MIN_MOVE_M)) {
          lastSample.current = { t: Date.now(), lat: p.lat, lng: p.lng };
          addDoc(collection(db, 'orgs', orgId, 'locationSamples'), {
            staffId,
            date,
            clientTime: Date.now(),
            lat: p.lat,
            lng: p.lng,
            accuracy: p.accuracy,
          }).catch(() => {});
        }
        // ジオフェンス：外→中で到着、終わった訪問の中→外で退出
        for (const stop of stopsRef.current) {
          const c = stop.client?.place;
          if (!c || c.lat === null || c.lng === null) continue;
          const prev = fences.current.get(stop.visit.id) ?? 'unknown';
          const next = geofenceState(p, { lat: c.lat, lng: c.lng }, radius, prev);
          fences.current.set(stop.visit.id, next);
          const has = (t: string) => stop.events.some((e) => e.type === t);
          if (next === 'inside' && prev !== 'inside' && !has('arrive') && stop.status === 'todo') {
            recordEvent(orgId, { staffId, date, type: 'arrive', visitId: stop.visit.id, source: 'geofence', pos });
          }
          if (next === 'outside' && prev === 'inside' && has('service_end') && !has('depart')) {
            recordEvent(orgId, { staffId, date, type: 'depart', visitId: stop.visit.id, source: 'geofence', pos });
          }
        }
      },
      (err) => {
        setState({
          tracking: false,
          error:
            err.code === err.PERMISSION_DENIED
              ? '位置情報が許可されていません（設定で許可してください）'
              : '位置が取れません',
          lastAccuracy: null,
        });
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [onShift, s.orgId, s.staffId, radius]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
