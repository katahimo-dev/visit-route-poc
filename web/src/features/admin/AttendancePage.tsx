import {
  ATTENDANCE_FIELDS,
  type AttendanceDay,
  type AttendanceStatus,
  type AttendanceVisit,
  type Client,
  jstDate,
  jstHhmm,
  type Staff,
  type Visit,
} from '@vrp/shared';
import { where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { call, saveCsv } from '../../lib/api';
import { useOrgCollection, type WithId } from '../../lib/useCollection';
import { DateField, formError, useAdmin } from './common';

/** 勤怠：その日の候補を見て承認する。月ごとのCSVを保存する */

type Field = (typeof ATTENDANCE_FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { arrive: '到着', start: '開始', end: '終了', depart: '退出' };
const STATUS_LABELS: Record<AttendanceStatus, string> = {
  candidate: '候補',
  confirmed_by_staff: '本人確認済み',
  approved: '承認済み',
};

/** 訂正を反映した値（functions の attendance と同じ。functions/ は import しないので写している） */
function effective(v: AttendanceVisit, field: Field): number | null {
  return v.corrections[field] ?? v[field];
}

const hm = (ms: number | null) => (ms === null ? '—' : jstHhmm(ms));

export default function AttendancePage() {
  const { orgId, terms, isOperator } = useAdmin();
  const toast = useToast();
  const [date, setDate] = useState(() => jstDate(Date.now()));
  const [month, setMonth] = useState(() => jstDate(Date.now()).slice(0, 7));
  const daysQ = useOrgCollection<AttendanceDay>(orgId, 'attendanceDays', [where('date', '==', date)], date);
  const visitsQ = useOrgCollection<Visit>(orgId, 'visits', [where('date', '==', date)], date);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const staffName = (id: string) => staffQ.rows?.find((s) => s.id === id)?.name ?? '（不明）';
  const clientNameOf = useMemo(() => {
    const vs = new Map((visitsQ.rows ?? []).map((v) => [v.id, v]));
    const cs = new Map((clientsQ.rows ?? []).map((c) => [c.id, c]));
    return (visitId: string) => {
      const v = vs.get(visitId);
      return (v && cs.get(v.clientId)?.displayName) || '（不明）';
    };
  }, [visitsQ.rows, clientsQ.rows]);
  const days = [...(daysQ.rows ?? [])].sort((a, b) => staffName(a.staffId).localeCompare(staffName(b.staffId), 'ja'));

  const approve = async (d: WithId<AttendanceDay>) => {
    setBusy(d.id);
    setError(null);
    try {
      await call('approveAttendance', {
        staffId: d.staffId,
        date: d.date,
        version: d.version,
        orgId: isOperator ? orgId : null,
      });
      toast('承認しました');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    setBusy('csv');
    setError(null);
    try {
      const r = await call('exportAttendanceCsv', { month, orgId: isOperator ? orgId : null });
      if (r.files.length === 0) setError('この月のデータがありません');
      for (const f of r.files) saveCsv(f.name, f.csv);
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <h2>勤怠</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={setDate} />
          <label style={{ maxWidth: 200, marginLeft: 24 }}>
            月
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </label>
          <button type="button" className="btn" disabled={busy === 'csv'} onClick={exportCsv}>
            CSVを保存
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {daysQ.rows === null ? (
        <p className="sub">読み込み中…</p>
      ) : days.length === 0 ? (
        <p className="sub">この日の勤怠はまだありません。</p>
      ) : (
        days.map((d) => (
          <div key={d.id} className="card stack">
            <div className="spread">
              <div className="row">
                <h3 style={{ margin: 0 }}>{staffName(d.staffId)}</h3>
                <span
                  className={`chip ${d.status === 'approved' ? 'chip-ok' : d.status === 'confirmed_by_staff' ? 'chip-primary' : ''}`}
                >
                  {STATUS_LABELS[d.status]}
                </span>
                <span className="sub">
                  勤務 {hm(d.shiftStart)}〜{hm(d.shiftEnd)}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={d.status === 'approved' || busy === d.id}
                onClick={() => approve(d)}
              >
                承認
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{terms.client}</th>
                  <th>予定</th>
                  {ATTENDANCE_FIELDS.map((f) => (
                    <th key={f} className="num">
                      {FIELD_LABELS[f]}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.visits.map((v) => (
                  <tr key={v.visitId}>
                    <td>{clientNameOf(v.visitId)}</td>
                    <td>
                      {v.planned.start}〜{v.planned.end}
                    </td>
                    {ATTENDANCE_FIELDS.map((f) => (
                      <td key={f} className="num">
                        {hm(effective(v, f))}
                        {v.corrections[f] !== undefined && (
                          <span className="chip chip-warn" style={{ marginLeft: 4 }}>
                            訂正
                          </span>
                        )}
                      </td>
                    ))}
                    <td>
                      {v.arriveFilled && <span className="chip">補完</span>}{' '}
                      {v.changed && <span className="chip chip-warn">変更あり</span>}
                      {v.correctionNote && <div className="sub">訂正：{v.correctionNote}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row sub" style={{ flexWrap: 'wrap', gap: 16 }}>
              <span>実働 {d.totals.workMinutes}分</span>
              <span>移動 {d.totals.travelMinutes}分</span>
              <span>休憩 {d.totals.breakMinutes}分</span>
              <span>拘束 {d.totals.boundMinutes}分</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
