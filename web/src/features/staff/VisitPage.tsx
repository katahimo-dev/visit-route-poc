import { jstDate, jstHhmm } from '@vrp/shared';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { useSession } from '../../lib/session';
import { ClientDot, STATUS_LABEL, timeRange } from './parts';
import { currentPosition, recordEvent } from './recordEvent';
import type { useStaffDay } from './useStaffDay';

/**
 * 訪問1件：顧客情報（開いた・閉じた時刻＝T1）、経路（T2）、はじめる（T4）・おわる。
 * 主ボタンは状態に応じて1つだけ出す。
 */
export function VisitPage({ day }: { day: ReturnType<typeof useStaffDay> }) {
  const { visitId } = useParams();
  const s = useSession();
  const toast = useToast();
  const stop = day.stops.find((x) => x.visit.id === visitId);
  const opened = useRef(false);

  // 顧客情報を開いた・閉じた時刻（T1）
  useEffect(() => {
    if (!s.orgId || !s.staffId || !visitId || opened.current) return;
    opened.current = true;
    const base = { staffId: s.staffId, date: jstDate(Date.now()), visitId, source: 'button' as const };
    const orgId = s.orgId;
    recordEvent(orgId, { ...base, type: 'client_open' });
    return () => recordEvent(orgId, { ...base, type: 'client_close' });
  }, [s.orgId, s.staffId, visitId]);

  if (day.loading) return <p className="sub">読み込み中…</p>;
  if (!stop || !s.orgId || !s.staffId) {
    return (
      <div className="card stack">
        <p>この訪問は見つかりません（予定が変わった可能性があります）</p>
        <Link to="/staff" className="btn">
          ホームへ
        </Link>
      </div>
    );
  }
  const orgId = s.orgId;
  const staffId = s.staffId;
  const place = stop.client?.place;
  const timeOf = (t: string) => {
    const e = stop.events.find((x) => x.type === t);
    return e ? jstHhmm(e.clientTime) : null;
  };

  const press = async (type: 'service_start' | 'service_end') => {
    const pos = await currentPosition();
    recordEvent(orgId, { staffId, date: day.date, type, visitId: stop.visit.id, source: 'button', pos });
    toast(type === 'service_start' ? 'はじめました' : 'おつかれさまでした');
  };

  const openRoute = () => {
    recordEvent(orgId, { staffId, date: day.date, type: 'route_open', visitId: stop.visit.id, source: 'button' });
    const dest =
      place?.lat != null && place.lng != null ? `${place.lat},${place.lng}` : encodeURIComponent(place?.address ?? '');
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}`, '_blank', 'noopener');
  };

  return (
    <>
      <div className="row">
        <ClientDot stop={stop} />
        <div>
          <h2 style={{ margin: 0 }}>{stop.client?.displayName ?? '（不明）'}さん</h2>
          {stop.status !== 'todo' && <span className="chip chip-primary">{STATUS_LABEL[stop.status]}</span>}
        </div>
      </div>
      <div className="card stack">
        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>🕙 {timeRange(stop)}</div>
        {place?.address && <div>📍 {place.address}</div>}
        {stop.client?.note && (
          <div className="card" style={{ background: '#fdf6ee' }}>
            ⚠ {stop.client.note}
          </div>
        )}
        {stop.visit.note && <div className="sub">{stop.visit.note}</div>}
        <button type="button" className="btn" onClick={openRoute}>
          🗺 道を見る
        </button>
      </div>

      {stop.status === 'done' ? (
        <div className="card">
          <p>
            おわりました（{timeOf('service_start')}〜{timeOf('service_end')}）
          </p>
          <Link to="/staff">ホームへ</Link>
        </div>
      ) : stop.status === 'in_service' ? (
        <button type="button" className="btn btn-primary btn-big" onClick={() => press('service_end')}>
          ■ おわる
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-big" onClick={() => press('service_start')}>
          ▶ はじめる
        </button>
      )}
      {!day.onShift && stop.status !== 'done' && (
        <p className="sub">「お仕事をはじめる」を押すと、到着が自動で記録されます。</p>
      )}
      <div className="sub">
        {timeOf('arrive') && `着いた ${timeOf('arrive')}　`}
        {timeOf('service_start') && `はじめた ${timeOf('service_start')}`}
      </div>
    </>
  );
}
