import { jstDate } from '@vrp/shared';
import { Link } from 'react-router-dom';
import { logout, useSession } from '../../lib/session';
import { ClientDot, legMinutes, MODE_ICON, STATUS_LABEL, timeRange } from './parts';
import { currentPosition, recordEvent } from './recordEvent';
import { useTracker } from './ShiftTracker';
import type { useStaffDay } from './useStaffDay';

/** ホーム：つぎの訪問だけ大きく。勤務の開始・終了（＝位置の計測の開始・終了） */
export function HomePage({ day }: { day: ReturnType<typeof useStaffDay> }) {
  const s = useSession();
  const tracker = useTracker();
  if (day.loading) return <p className="sub">読み込み中…</p>;
  const next = day.stops.find((x) => x.status !== 'done');
  const idx = next ? day.stops.indexOf(next) : -1;
  const prevPlace = idx > 0 ? day.stops[idx - 1]?.client?.place : day.me?.home;
  const mode = day.me?.travelMode ?? 'DRIVE';
  const mins = next ? legMinutes(prevPlace, next.client?.place, mode) : null;

  const shift = async (type: 'shift_start' | 'shift_end') => {
    if (!s.orgId || !s.staffId) return;
    if (type === 'shift_end' && !confirm('今日の勤務を終了しますか？（位置の記録を止めます）')) return;
    const pos = await currentPosition();
    recordEvent(s.orgId, { staffId: s.staffId, date: jstDate(Date.now()), type, visitId: null, source: 'button', pos });
  };

  return (
    <>
      <div className="spread">
        <div>
          <div className="sub">お疲れさまです</div>
          <h2>{day.me?.name ?? ''}さん</h2>
        </div>
        <button type="button" className="btn btn-small" onClick={() => logout()}>
          ログアウト
        </button>
      </div>

      {day.onShift ? (
        <div className="spread">
          {tracker.tracking ? (
            <span className="tracking">位置を記録しています（勤務中のみ）</span>
          ) : (
            <span className="sub">位置を確認しています…</span>
          )}
          <button type="button" className="btn btn-small" onClick={() => shift('shift_end')}>
            勤務を終了
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-big" onClick={() => shift('shift_start')}>
          勤務を開始
        </button>
      )}
      {tracker.error && <p className="error">{tracker.error}</p>}

      {next ? (
        <div className="card stack">
          <span className="chip chip-primary" style={{ alignSelf: 'flex-start' }}>
            次の訪問 {STATUS_LABEL[next.status]}
          </span>
          <div className="row">
            <ClientDot stop={next} />
            <h2 style={{ margin: 0 }}>{next.client?.displayName ?? '（不明）'}さん</h2>
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>🕙 {timeRange(next)}</div>
          {mins !== null && (
            <div className="sub">
              {MODE_ICON[mode]} {idx > 0 ? '前の訪問から' : '自宅から'} 約{mins}分
            </div>
          )}
          <Link
            to={`/staff/visit/${next.visit.id}`}
            className="btn btn-primary btn-big"
            style={{ textAlign: 'center', textDecoration: 'none' }}
          >
            開く
          </Link>
        </div>
      ) : (
        <div className="card">
          <p>{day.stops.length ? '今日の訪問はすべて終わりました' : '今日の訪問はありません'}</p>
        </div>
      )}

      {day.stops.length > 1 && (
        <div className="row" style={{ overflowX: 'auto' }}>
          {day.stops.map((st) => (
            <Link
              key={st.visit.id}
              to={`/staff/visit/${st.visit.id}`}
              className="card"
              style={{
                textDecoration: 'none',
                minWidth: 96,
                textAlign: 'center',
                opacity: st.status === 'done' ? 0.5 : 1,
              }}
            >
              <ClientDot stop={st} small />
              <div style={{ fontWeight: 700 }}>{st.visit.earliestStart}</div>
              <div className="sub">{STATUS_LABEL[st.status] || ' '}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
