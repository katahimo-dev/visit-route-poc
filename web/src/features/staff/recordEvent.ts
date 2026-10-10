import { EVENT_TYPES, type VisitEvent } from '@vrp/shared';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';

/**
 * スタッフの記録を書く。文書IDは端末で作る UUID なので、再送しても1件にしかならない（R9）。
 * 電波が無くても端末に残り、つながったら送られる。送信完了は待たない（待つとオフラインで止まる）。
 */
export function recordEvent(
  orgId: string,
  e: Omit<VisitEvent, 'clientTime' | 'lat' | 'lng' | 'accuracy'> & { pos?: GeolocationPosition | null },
): void {
  if (!EVENT_TYPES.includes(e.type)) return;
  const { pos, ...rest } = e;
  const data: VisitEvent = {
    ...rest,
    clientTime: Date.now(),
    lat: pos?.coords.latitude ?? null,
    lng: pos?.coords.longitude ?? null,
    accuracy: pos?.coords.accuracy ?? null,
  };
  setDoc(doc(db, 'orgs', orgId, 'events', crypto.randomUUID()), data).catch(() => {
    // 権限エラーなど。オフラインは失敗にならない（端末に残る）
  });
}

/** 今の位置を1回だけ取る（取れなければ null。ボタンの操作を止めない） */
export function currentPosition(timeoutMs = 5000): Promise<GeolocationPosition | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 30000,
    });
  });
}
