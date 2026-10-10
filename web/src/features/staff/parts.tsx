import { estimateLeg, hhmmToMinutes, minutesToHhmm, type TravelMode } from '@vrp/shared';
import { colorOf, initialOf } from '../../lib/colors';
import type { StaffStop } from './useStaffDay';

export function ClientDot({ stop, small }: { stop: StaffStop; small?: boolean }) {
  const name = stop.client?.displayName ?? '?';
  return (
    <span className={`dot${small ? ' dot-sm' : ''}`} style={{ background: colorOf(stop.client?.color ?? 0) }}>
      {initialOf(name)}
    </span>
  );
}

export const timeRange = (stop: StaffStop) =>
  `${stop.visit.earliestStart}〜${minutesToHhmm(hhmmToMinutes(stop.visit.earliestStart) + stop.visit.durationMinutes)}`;

export const STATUS_LABEL: Record<StaffStop['status'], string> = {
  todo: '',
  arrived: '着いた',
  in_service: '訪問中',
  done: 'おわり',
};

type P = { lat: number | null; lng: number | null } | undefined;

/** 区間の移動時間の目安（分）。α は直線距離からの概算（地図APIの予測は改修版で表示） */
export function legMinutes(from: P, to: P, mode: TravelMode): number | null {
  if (!from || !to || from.lat === null || from.lng === null || to.lat === null || to.lng === null) return null;
  return Math.max(
    1,
    Math.round(estimateLeg({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, mode).seconds / 60),
  );
}

export const MODE_ICON: Record<TravelMode, string> = { DRIVE: '🚗', BICYCLE: '🚲', WALK: '🚶', TRANSIT: '🚃' };
