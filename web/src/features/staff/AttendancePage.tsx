import { type AttendanceDay, type AttendanceVisit, type Client, jstHhmm, jstToMs, type Visit } from '@vrp/shared';
import { where } from 'firebase/firestore';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { call, messageOf } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useOrgCollection, useOrgDoc } from '../../lib/useCollection';

const FIELDS = [
  ['arrive', '着いた'],
  ['start', 'はじめた'],
  ['end', 'おわった'],
  ['depart', '出た'],
] as const;

const eff = (v: AttendanceVisit, f: (typeof FIELDS)[number][0]) => v.corrections[f] ?? v[f];
const STATUS: Record<AttendanceDay['status'], string> = {
  candidate: '確認まち',
  confirmed_by_staff: '確認ずみ（承認まち）',
  approved: '承認ずみ',
};

/** きんむ：きょうの到着・退出の確認と訂正（勤怠候補。自動では確定しない） */
export function AttendancePage({ date }: { date: string }) {
  const s = useSession();
  const toast = useToast();
  const day = useOrgDoc<AttendanceDay>(s.orgId, 'attendanceDays', s.staffId ? `${s.staffId}_${date}` : null);
  // 当日の訪問だけを購読する（全期間を読むと日数に比例して読み取りが増える）
  const { rows: visits } = useOrgCollection<Visit>(s.orgId, 'visits', [where('date', '==', date)], date);
  const { rows: clients } = useOrgCollection<Client>(s.orgId, 'clients');
  const [busy, setBusy] = useState(false);

  if (day === undefined) return <p className="sub">読み込み中…</p>;
  if (day === null) {
    return (
      <div className="card">
        <h2>きょうのきんむ</h2>
        <p>まだ記録がありません。「はじめる」を押すと記録されます。</p>
      </div>
    );
  }
  const nameOf = (visitId: string) => {
    const v = visits?.find((x) => x.id === visitId);
    return clients?.find((c) => c.id === v?.clientId)?.displayName ?? '訪問';
  };
  const locked = day.status === 'approved';

  const correct = async (v: AttendanceVisit, field: (typeof FIELDS)[number][0], hhmm: string) => {
    if (!hhmm) return;
    const note = prompt('直す理由（例：押しわすれ）') ?? '';
    setBusy(true);
    try {
      await call('correctAttendance', {
        staffId: null,
        date,
        visitId: v.visitId,
        field,
        value: jstToMs(date, hhmm),
        note,
        version: day.version,
      });
      toast('直しました');
    } catch (e) {
      toast(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDay = async () => {
    setBusy(true);
    try {
      await call('confirmAttendance', { date, version: day.version });
      toast('確認しました');
    } catch (e) {
      toast(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const t = day.totals;
  return (
    <>
      <div className="spread">
        <h2>きょうのきんむ</h2>
        <span className={`chip ${locked ? 'chip-ok' : 'chip-warn'}`}>{STATUS[day.status]}</span>
      </div>
      <div className="card row" style={{ justifyContent: 'space-around', textAlign: 'center' }}>
        {[
          ['はたらいた', t.workMinutes],
          ['移動', t.travelMinutes],
          ['休けい', t.breakMinutes],
        ].map(([label, m]) => (
          <div key={label as string}>
            <div className="sub">{label}</div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>
              {Math.floor((m as number) / 60)}:{String((m as number) % 60).padStart(2, '0')}
            </div>
          </div>
        ))}
      </div>
      {day.visits.map((v) => (
        <div key={v.visitId} className="card stack">
          <div className="spread">
            <strong>{nameOf(v.visitId)}さん</strong>
            <span className="sub">
              予定 {v.planned.start}〜{v.planned.end}
            </span>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {FIELDS.map(([f, label]) => {
              const ms = eff(v, f);
              return (
                <label key={f}>
                  {label}
                  {f === 'arrive' && v.arriveFilled && <span className="chip">はじめた時刻で記録</span>}
                  {v.corrections[f] !== undefined && <span className="chip chip-warn">直した</span>}
                  <input
                    type="time"
                    disabled={locked || busy}
                    defaultValue={ms ? jstHhmm(ms) : ''}
                    onBlur={(e) => {
                      const cur = ms ? jstHhmm(ms) : '';
                      if (e.target.value && e.target.value !== cur) correct(v, f, e.target.value);
                    }}
                  />
                </label>
              );
            })}
          </div>
          {v.changed && <span className="chip chip-warn">予定と15分以上ちがいます</span>}
        </div>
      ))}
      {!locked && (
        <button
          type="button"
          className="btn btn-primary btn-big"
          disabled={busy || day.status === 'confirmed_by_staff'}
          onClick={confirmDay}
        >
          {day.status === 'confirmed_by_staff' ? '確認ずみ' : 'この内容で合っています'}
        </button>
      )}
      {locked && <p className="sub">承認ずみです。直したいときは事業所に連絡してください。</p>}
    </>
  );
}
