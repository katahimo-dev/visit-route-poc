import type { Client, PlanMetrics, SolveResponse, Staff, UnassignedReason, Visit } from '@vrp/shared';
import { doc, updateDoc, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { type MapLine, type MapPoint, RouteMap } from '../../components/RouteMap';
import { useToast } from '../../components/Toast';
import { call } from '../../lib/api';
import { colorOf, initialOf } from '../../lib/colors';
import { db } from '../../lib/firebase';
import { useOrgCollection, type WithId } from '../../lib/useCollection';
import { DateField, formError, hasLocation, tomorrow, useAdmin } from './common';

/** AI案：作る・結果を見る（読み取りだけ。決定・手直しは α に含めない） */

type PlanRun = {
  date: string;
  createdAt: number;
  mode: string;
  travelMode: string;
  computeMillis: number;
  solverVersion: string;
  /** 移動時間に地図API（Google）を使ったか。古い結果には無い */
  mapsApi?: boolean;
  manualRoutes: Record<string, string[]>;
  manualMinutesSpent: number | null;
  result: SolveResponse;
  metrics: { manual: PlanMetrics; ai: PlanMetrics };
  skipped: { kind: 'staff' | 'visit'; id: string; reason: string }[];
};

const REASON_LABELS: Record<UnassignedReason, string> = {
  time_window: '時間の約束',
  shift: '勤務時間',
  gender: '性別の希望',
  ng_staff: 'NGの組み合わせ',
  unreachable: '行けない場所',
};
const SKIP_LABELS: Record<string, string> = { no_location: '位置が未登録', not_working: '勤務日ではない' };

const r1 = (n: number) => Math.round(n * 10) / 10;
const sign = (n: number) => (n > 0 ? `+${r1(n)}` : String(r1(n)));

export default function PlanPage() {
  const { orgId, org, terms, isOperator } = useAdmin();
  const toast = useToast();
  const [date, setDate] = useState(tomorrow);
  const runsQ = useOrgCollection<PlanRun>(orgId, 'planRuns', [where('date', '==', date)], date);
  const visitsQ = useOrgCollection<Visit>(orgId, 'visits', [where('date', '==', date)], date);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [mapStaff, setMapStaff] = useState<string | null>(null);

  const runs = useMemo(() => [...(runsQ.rows ?? [])].sort((a, b) => b.createdAt - a.createdAt), [runsQ.rows]);
  const run: WithId<PlanRun> | undefined = runs.find((r) => r.id === picked) ?? runs[0];
  const staffById = useMemo(() => new Map((staffQ.rows ?? []).map((s) => [s.id, s])), [staffQ.rows]);
  const clientById = useMemo(() => new Map((clientsQ.rows ?? []).map((c) => [c.id, c])), [clientsQ.rows]);
  const visitById = useMemo(() => new Map((visitsQ.rows ?? []).map((v) => [v.id, v])), [visitsQ.rows]);

  const useMaps = org?.useMapsApi !== false;
  const setUseMaps = async (v: boolean) => {
    setError(null);
    try {
      await updateDoc(doc(db, 'orgs', orgId), { useMapsApi: v });
      toast(v ? 'Google の地図APIを使います' : '直線距離からの概算にします');
    } catch (e) {
      setError(formError(e));
    }
  };

  const staffName = (id: string) => staffById.get(id)?.name ?? '（不明）';
  const visitLabel = (id: string) => {
    const v = visitById.get(id);
    const c = v && clientById.get(v.clientId);
    return `${v ? v.earliestStart : ''} ${c?.displayName ?? '（不明）'}`.trim();
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await call('createPlanRun', {
        date,
        requestId: crypto.randomUUID(),
        orgId: isOperator ? orgId : null,
      });
      setPicked(runId);
      toast('AI案を作成しました');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  const staffIds = run
    ? [
        ...new Set([
          ...Object.keys(run.metrics.manual.perStaff),
          ...Object.keys(run.metrics.ai.perStaff),
          ...run.result.routes.map((x) => x.staffId),
        ]),
      ]
    : [];
  const mapStaffId = mapStaff && staffIds.includes(mapStaff) ? mapStaff : (staffIds[0] ?? null);

  const { points, lines } = useMemo(() => {
    const pts: MapPoint[] = [];
    const lns: MapLine[] = [];
    if (!run || !mapStaffId) return { points: pts, lines: lns };
    const s = staffById.get(mapStaffId);
    const home = s && hasLocation(s.home) ? { lat: s.home.lat, lng: s.home.lng } : null;
    if (home) pts.push({ ...home, label: '家', color: '#8a7a70' });
    const pathOf = (ids: string[]) => {
      const path: { lat: number; lng: number }[] = home ? [home] : [];
      for (const id of ids) {
        const v = visitById.get(id);
        const c = v && clientById.get(v.clientId);
        if (!c || !hasLocation(c.place)) continue;
        path.push({ lat: c.place.lat, lng: c.place.lng });
        if (!pts.some((p) => p.lat === c.place.lat && p.lng === c.place.lng && p.label === initialOf(c.displayName))) {
          pts.push({ lat: c.place.lat, lng: c.place.lng, label: initialOf(c.displayName), color: colorOf(c.color) });
        }
      }
      if (home && path.length > 1) path.push(home);
      return path;
    };
    const manualIds = run.manualRoutes?.[mapStaffId] ?? [];
    const aiIds = run.result.routes.find((x) => x.staffId === mapStaffId)?.stops.map((x) => x.visitId) ?? [];
    lns.push({ points: pathOf(manualIds), color: '#4a7fc1', dashed: true });
    lns.push({ points: pathOf(aiIds), color: '#e8735f' });
    return { points: pts, lines: lns };
  }, [run, mapStaffId, staffById, visitById, clientById]);

  const m = run?.metrics.manual;
  const a = run?.metrics.ai;
  const rows: { label: string; unit: string; manual: number; ai: number }[] =
    m && a
      ? [
          { label: '移動時間', unit: '分', manual: m.travelSeconds / 60, ai: a.travelSeconds / 60 },
          { label: '移動距離', unit: 'km', manual: m.meters / 1000, ai: a.meters / 1000 },
          { label: '交通費', unit: '円', manual: m.fareYen, ai: a.fareYen },
          { label: '待ち時間', unit: '分', manual: m.waitSeconds / 60, ai: a.waitSeconds / 60 },
          { label: '条件違反', unit: '件', manual: m.violations, ai: a.violations },
        ]
      : [];
  const reduction =
    m && a && m.travelSeconds > 0 ? ((m.travelSeconds - a.travelSeconds) / m.travelSeconds) * 100 : null;

  return (
    <div className="stack">
      <h2>AI案</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={setDate} />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
            {busy ? '作成中…（数十秒かかります）' : 'AI案を作成'}
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="sub">移動時間の求め方：</span>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={useMaps}
              className={useMaps ? 'is-on' : ''}
              onClick={() => setUseMaps(true)}
            >
              Google の地図API（実際の道路）
            </button>
            <button
              type="button"
              aria-pressed={!useMaps}
              className={useMaps ? '' : 'is-on'}
              onClick={() => setUseMaps(false)}
            >
              直線距離からの概算（無料）
            </button>
          </div>
        </div>
        <p className="sub">
          AI案は予定を書き換えません。手作業案と同じ移動時間の予測で比較するだけです。地図APIは使った分だけ費用がかかります（同じ区間は30日間使い回します）。
        </p>
        {error && <p className="error">{error}</p>}
        {runs.length > 1 && (
          <label style={{ maxWidth: 360 }}>
            作成した結果（新しい順）
            <select value={run?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {runsQ.rows === null ? (
        <p className="sub">読み込み中…</p>
      ) : !run || !m || !a ? (
        <p className="sub">この日のAI案はまだありません。</p>
      ) : (
        <>
          <div className="card stack">
            <div className="spread">
              <h3>手作業とAIの比較</h3>
              <span className="sub">
                {new Date(run.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ／ 計算{' '}
                {r1(run.computeMillis / 1000)}秒 ／ 移動時間{' '}
                {run.mapsApi === false ? '直線距離からの概算' : run.mapsApi ? 'Google の地図API' : '—'}
                {run.manualMinutesSpent != null && ` ／ 手作業のルート作成 ${run.manualMinutesSpent}分`}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th />
                  <th className="num">現在（手作業）</th>
                  <th className="num">AI</th>
                  <th className="num">差（AI−現在）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td>
                      {r.label}（{r.unit}）
                    </td>
                    <td className="num">{r1(r.manual)}</td>
                    <td className="num">{r1(r.ai)}</td>
                    <td className="num">{sign(r.ai - r.manual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <strong>チーム全体の移動時間の削減率：</strong>
              {reduction === null ? (
                <span className="sub">計算できません（手作業案の移動時間が0）</span>
              ) : (
                <span className={`chip ${reduction >= 20 ? 'chip-ok' : 'chip-warn'}`} style={{ fontSize: '1rem' }}>
                  {r1(reduction)}%
                </span>
              )}
              <span className="sub">目標は 20〜30%</span>
            </div>
          </div>

          <div className="card stack">
            <h3>{terms.staff}ごと</h3>
            <table>
              <thead>
                <tr>
                  <th>{terms.staff}</th>
                  <th className="num">訪問（手作業→AI）</th>
                  <th className="num">移動 手作業（分）</th>
                  <th className="num">移動 AI（分）</th>
                  <th className="num">条件違反 手作業→AI</th>
                </tr>
              </thead>
              <tbody>
                {staffIds.map((id) => {
                  const pm = m.perStaff[id];
                  const pa = a.perStaff[id];
                  return (
                    <tr key={id}>
                      <td>{staffName(id)}</td>
                      <td className="num">
                        {pm?.visitCount ?? 0} → {pa?.visitCount ?? 0}
                      </td>
                      <td className="num">{r1((pm?.travelSeconds ?? 0) / 60)}</td>
                      <td className="num">{r1((pa?.travelSeconds ?? 0) / 60)}</td>
                      <td className="num">
                        {pm?.violations ?? 0} → {pa?.violations ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card stack">
            <h3>AI案の順番</h3>
            <div className="grid2">
              {run.result.routes
                .filter((r) => r.stops.length > 0)
                .map((r) => (
                  <div key={r.staffId} className="stack" style={{ gap: 4 }}>
                    <strong>{staffName(r.staffId)}</strong>
                    {r.stops.map((s, i) => (
                      <div key={s.visitId}>
                        <span className="sub">{i + 1}</span> {s.start}〜{s.end}　
                        {visitLabel(s.visitId).replace(/^\d{2}:\d{2} /, '')}
                        {s.waitMinutes ? <span className="sub">（待ち {s.waitMinutes}分）</span> : null}
                      </div>
                    ))}
                  </div>
                ))}
            </div>
            {run.result.routes.every((r) => r.stops.length === 0) && (
              <p className="sub">割り当てられた訪問がありません。</p>
            )}
          </div>

          {run.result.unassigned.length > 0 && (
            <div className="card stack">
              <h3>AI案で割り当てられなかった訪問</h3>
              {run.result.unassigned.map((u) => (
                <div key={u.visitId} className="row" style={{ flexWrap: 'wrap' }}>
                  <span>{visitLabel(u.visitId)}</span>
                  {u.reasons.map((r) => (
                    <span key={r} className="chip chip-warn">
                      {REASON_LABELS[r]}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {run.skipped.length > 0 && (
            <div className="card stack">
              <h3>計算に入れなかったもの</h3>
              {run.skipped.map((s) => (
                <div key={`${s.kind}:${s.id}`} className="row">
                  <span className="chip">{s.kind === 'staff' ? terms.staff : '訪問'}</span>
                  <span>{s.kind === 'staff' ? staffName(s.id) : visitLabel(s.id)}</span>
                  <span className="sub">{SKIP_LABELS[s.reason] ?? s.reason}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card stack">
            <div className="spread">
              <h3>地図（点線：手作業、実線：AI）</h3>
              <label style={{ maxWidth: 220 }}>
                {terms.staff}
                <select value={mapStaffId ?? ''} onChange={(e) => setMapStaff(e.target.value)}>
                  {staffIds.map((id) => (
                    <option key={id} value={id}>
                      {staffName(id)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <RouteMap points={points} lines={lines} height={340} />
            <div className="row sub">
              <span style={{ color: '#4a7fc1' }}>- - - 手作業</span>
              <span style={{ color: '#e8735f' }}>━━ AI</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
