import { Link } from 'react-router-dom';
import { type MapPoint, RouteMap } from '../../components/RouteMap';
import { colorOf, initialOf } from '../../lib/colors';
import { ClientDot, legMinutes, MODE_ICON, STATUS_LABEL, timeRange } from './parts';
import type { useStaffDay } from './useStaffDay';

/** よてい：きょうの回る順番（地図＋順番＋区間の移動時間） */
export function TodayPage({ day }: { day: ReturnType<typeof useStaffDay> }) {
  if (day.loading) return <p className="sub">読み込み中…</p>;
  const mode = day.me?.travelMode ?? 'DRIVE';
  const home = day.me?.home;
  const points: MapPoint[] = [];
  if (home?.lat != null && home.lng != null)
    points.push({ lat: home.lat, lng: home.lng, label: '家', color: '#f0a050' });
  for (const st of day.stops) {
    const p = st.client?.place;
    if (p?.lat != null && p.lng != null)
      points.push({
        lat: p.lat,
        lng: p.lng,
        label: initialOf(st.client?.displayName ?? '?'),
        color: colorOf(st.client?.color ?? 0),
      });
  }
  const line = { points: points.map(({ lat, lng }) => ({ lat, lng })), color: '#e8735f' };
  const total = day.stops.reduce((sum, st, i) => {
    const from = i === 0 ? home : day.stops[i - 1]?.client?.place;
    return sum + (legMinutes(from, st.client?.place, mode) ?? 0);
  }, 0);

  return (
    <>
      <div className="spread">
        <h2>きょうの回る順番</h2>
        <span className="chip">
          {MODE_ICON[mode]} 移動 あわせて約{total}分
        </span>
      </div>
      {points.length > 0 && <RouteMap points={points} lines={[line]} height={240} />}
      <div className="card">
        {day.stops.length === 0 && <p>きょうの訪問はありません</p>}
        {day.stops.map((st, i) => {
          const from = i === 0 ? home : day.stops[i - 1]?.client?.place;
          const mins = legMinutes(from, st.client?.place, mode);
          return (
            <div key={st.visit.id}>
              {mins !== null && (
                <div className="leg">
                  {MODE_ICON[mode]} 約{mins}分
                </div>
              )}
              <Link
                to={`/staff/visit/${st.visit.id}`}
                className={`stop${st.status === 'done' ? ' done' : ''}`}
                style={{ textDecoration: 'none' }}
              >
                <ClientDot stop={st} />
                <div className="grow">
                  <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{st.client?.displayName ?? '（不明）'}さん</div>
                  <div className="sub">{timeRange(st)}</div>
                </div>
                {st.status !== 'todo' && (
                  <span className={`chip ${st.status === 'done' ? 'chip-ok' : 'chip-primary'}`}>
                    {STATUS_LABEL[st.status]}
                  </span>
                )}
              </Link>
            </div>
          );
        })}
      </div>
      <p className="sub">移動時間は目安です（道路の混み具合で変わります）。</p>
    </>
  );
}
