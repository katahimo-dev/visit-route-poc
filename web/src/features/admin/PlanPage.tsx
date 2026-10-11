import type {
  Client,
  PlanMetrics,
  RouteView,
  SolveResponse,
  Staff,
  StopView,
  UnassignedReason,
  Visit,
} from '@vrp/shared';
import { minutesToHhmm } from '@vrp/shared';
import { doc, updateDoc, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { type MapLine, type MapPoint, RouteMap } from '../../components/RouteMap';
import { useToast } from '../../components/Toast';
import { call } from '../../lib/api';
import { colorOf, initialOf } from '../../lib/colors';
import { db } from '../../lib/firebase';
import { useOrgCollection, type WithId } from '../../lib/useCollection';
import { DateField, formError, hasLocation, staffColor, tomorrow, useAdmin } from './common';
import { ClientName } from './parts';

/**
 * AI案：作る・手作業案と並べて見る（読み取りだけ。決定・手直しは α に含めない）。
 * 担当ごとに1行で、左に手作業案、右に AI案を、予定画面と同じカードで並べる。
 * 地図APIを使った結果は、区間ごとに直線距離の概算の値も並べる
 */

type PlanRun = {
  date: string;
  createdAt: number;
  mode: string;
  travelMode: string;
  computeMillis: number;
  solverVersion: string;
  /** 移動時間に地図API（Google）の値を使ったか。古い結果には無い */
  mapsApi?: boolean;
  manualRoutes: Record<string, string[]>;
  manualMinutesSpent: number | null;
  result: SolveResponse;
  metrics: { manual: PlanMetrics; ai: PlanMetrics };
  /** 表示用の時刻と区間（古い結果には無い） */
  views?: { manual: Record<string, RouteView>; ai: Record<string, RouteView> };
  skipped: { kind: 'staff' | 'visit'; id: string; reason: string }[];
};

const REASON_LABELS: Record<UnassignedReason, string> = {
  time_window: '時間の約束',
  shift: '勤務時間',
  gender: '性別の希望',
  ng_staff: 'NGの組み合わせ',
  unreachable: '行けない場所',
};
const SKIP_LABELS: Record<string, string> = {
  no_location: '位置が未登録',
  not_working: '勤務日ではない',
  inactive: '休止中',
};

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const sign = (n: number) => (n > 0 ? `+${r1(n)}` : String(r1(n)));
const pct = (before: number, after: number) => (before > 0 ? ((before - after) / before) * 100 : null);
const sumOf = (views: Record<string, RouteView>, f: (v: RouteView) => number | null) =>
  Object.values(views).reduce((t, v) => t + (f(v) ?? 0), 0);

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
  // 色は予定画面と同じ（名前の順）
  const staffSorted = useMemo(
    () => [...(staffQ.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const staffById = useMemo(() => new Map(staffSorted.map((s) => [s.id, s])), [staffSorted]);
  const colorOfStaff = useMemo(() => new Map(staffSorted.map((s, i) => [s.id, staffColor(i)])), [staffSorted]);
  const clientById = useMemo(() => new Map((clientsQ.rows ?? []).map((c) => [c.id, c])), [clientsQ.rows]);
  const visitById = useMemo(() => new Map((visitsQ.rows ?? []).map((v) => [v.id, v])), [visitsQ.rows]);

  const useMaps = org?.useMapsApi !== false;
  const setUseMaps = async (v: boolean) => {
    setError(null);
    try {
      await updateDoc(doc(db, 'orgs', orgId), { useMapsApi: v });
      toast(v ? '次の AI案から Google の地図APIを使います' : '次の AI案から直線距離の概算にします');
    } catch (e) {
      setError(formError(e));
    }
  };

  const staffName = (id: string) => staffById.get(id)?.name ?? '（不明）';
  const clientOf = (visitId: string) => {
    const v = visitById.get(visitId);
    return v ? clientById.get(v.clientId) : undefined;
  };
  const visitLabel = (id: string) =>
    `${visitById.get(id)?.earliestStart ?? ''} ${clientOf(id)?.displayName ?? '（不明）'}`;

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

  // 担当：手作業案とAI案のどちらかに訪問のある人（予定画面と同じ順）
  const aiRoutes = useMemo(
    () => Object.fromEntries((run?.result.routes ?? []).map((r) => [r.staffId, r.stops.map((s) => s.visitId)])),
    [run],
  );
  const staffIds = useMemo(() => {
    if (!run) return [];
    const ids = new Set(
      [...Object.entries(run.manualRoutes ?? {}), ...Object.entries(aiRoutes)]
        .filter(([, v]) => v.length > 0)
        .map(([k]) => k),
    );
    const order = staffSorted.map((s) => s.id).filter((id) => ids.has(id));
    return [...order, ...[...ids].filter((id) => !order.includes(id))];
  }, [run, aiRoutes, staffSorted]);
  const ownerManual = useMemo(() => ownerMap(run?.manualRoutes ?? {}), [run]);
  const ownerAi = useMemo(() => ownerMap(aiRoutes), [aiRoutes]);
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
        const c = clientById.get(visitById.get(id)?.clientId ?? '');
        if (!c || !hasLocation(c.place)) continue;
        path.push({ lat: c.place.lat, lng: c.place.lng });
        if (!pts.some((p) => p.lat === c.place.lat && p.lng === c.place.lng)) {
          pts.push({ lat: c.place.lat, lng: c.place.lng, label: initialOf(c.displayName), color: colorOf(c.color) });
        }
      }
      if (home && path.length > 1) path.push(home);
      return path;
    };
    lns.push({ points: pathOf(run.manualRoutes?.[mapStaffId] ?? []), color: '#4a7fc1', dashed: true });
    lns.push({ points: pathOf(aiRoutes[mapStaffId] ?? []), color: '#e8735f' });
    return { points: pts, lines: lns };
  }, [run, mapStaffId, staffById, visitById, clientById, aiRoutes]);

  const m = run?.metrics.manual;
  const a = run?.metrics.ai;
  const views = run?.views;
  const hasEstimate = !!views && run?.mapsApi === true;
  const reduction = m && a ? pct(m.travelSeconds, a.travelSeconds) : null;
  const estManual = views ? sumOf(views.manual, (v) => v.estimateTravelMinutes) : 0;
  const estAi = views ? sumOf(views.ai, (v) => v.estimateTravelMinutes) : 0;

  const stopCards = (staffId: string, side: 'manual' | 'ai') => {
    const view = views?.[side][staffId];
    if (!view) {
      const manualIds = run?.manualRoutes?.[staffId] ?? [];
      const skip = run?.skipped.find((x) => x.kind === 'staff' && x.id === staffId);
      if (side === 'manual' && manualIds.length > 0)
        return (
          <div className="stack" style={{ gap: 4 }}>
            <span className="chip chip-red" style={{ alignSelf: 'flex-start' }}>
              計算に入れていません（{skip ? (SKIP_LABELS[skip.reason] ?? skip.reason) : '対象外'}）
            </span>
            {manualIds.map((id) => (
              <span key={id} className="sub">
                {visitLabel(id)}
              </span>
            ))}
          </div>
        );
      return <span className="sub">訪問なし</span>;
    }
    return (
      <div className="stack" style={{ gap: 0 }}>
        {view.off && (
          <span className="chip chip-red" style={{ alignSelf: 'flex-start' }}>
            この日は休み（稼働時間帯なし）なのに担当あり
          </span>
        )}
        {view.stops.map((s, i) => (
          <div key={s.visitId}>
            <Leg
              minutes={s.travelMinutes}
              estimate={hasEstimate ? s.estimateMinutes : null}
              from={i === 0 ? '自宅から' : null}
            />
            <StopCard
              stop={s}
              off={view.off}
              client={clientOf(s.visitId)}
              moved={movedLabel(s.visitId, staffId, side)}
            />
          </div>
        ))}
        <Leg
          minutes={view.backMinutes}
          estimate={hasEstimate ? view.backEstimateMinutes : null}
          from="自宅まで"
          warn={view.overShift ? '勤務終了を過ぎる' : null}
        />
      </div>
    );
  };
  /** 手作業案とAI案で担当が違う訪問の印 */
  const movedLabel = (visitId: string, staffId: string, side: 'manual' | 'ai'): string | null => {
    if (side === 'ai') {
      const before = ownerManual.get(visitId);
      if (before === staffId) return null;
      return before ? `← ${staffName(before)}から` : '← 未割当から';
    }
    const after = ownerAi.get(visitId);
    if (after === staffId) return null;
    return after ? `→ AIでは ${staffName(after)}` : '→ AIでは未割当';
  };

  return (
    <div className="stack">
      <h2>AI案</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={setDate} />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
            {busy ? '作成中…（数十秒かかります）' : 'AI案を作成'}
          </button>
          {runs.length > 1 && (
            <label style={{ maxWidth: 300 }}>
              作成した結果（新しい順）
              <select value={run?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（
                    {r.mapsApi ? 'Google' : '概算'}）
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="sub">移動時間の求め方：</span>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={useMaps}
                className={useMaps ? 'is-on' : ''}
                onClick={() => setUseMaps(true)}
              >
                Google の地図API
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
          <div className="method-help">
            <div>
              <strong>Google の地図API</strong>
              ：実際の道路の経路と、出発する時間帯の混み具合から車の所要時間を出します。
              使った区間の数だけ費用がかかります（同じ区間は30日間使い回します）。近い10か所どうしの区間だけを聞き、残りは概算を補正して埋めます。
            </div>
            <div>
              <strong>直線距離からの概算</strong>
              ：2地点の直線距離を1.3倍して道のりとし、時速25kmで割った時間です。川・山・一方通行・渋滞を知らないので、回り道の多い区間ではずれます。
            </div>
            <div className="sub">
              Google で作った AI案には、Google で測った区間にだけ、同じ区間の概算を「（概算
              ◯分）」と並べます（印の無い区間は、概算を Google の結果で補正した値）。切り替えは次に作る
              AI案から効きます。
            </div>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {runsQ.rows === null ? (
        <p className="sub">読み込み中…</p>
      ) : !run || !m || !a ? (
        <p className="sub">この日のAI案はまだありません。</p>
      ) : (
        <>
          <div className="card stack">
            <div className="spread" style={{ flexWrap: 'wrap' }}>
              <h3>手作業案とAI案の比較</h3>
              <span className="sub">
                {new Date(run.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ／ 移動時間{' '}
                {run.mapsApi === false ? '直線距離からの概算' : run.mapsApi ? 'Google の地図API' : '—'} ／ 計算{' '}
                {r1(run.computeMillis / 1000)}秒
                {run.manualMinutesSpent != null && ` ／ 手作業のルート作成 ${run.manualMinutesSpent}分`}
              </span>
            </div>
            <div className="kpi-row">
              <div className="kpi">
                <span className="sub">移動時間の合計</span>
                <span className="kpi-value">
                  {r0(m.travelSeconds / 60)}分 → <strong>{r0(a.travelSeconds / 60)}分</strong>
                </span>
                {reduction !== null && (
                  <span className={`chip ${reduction >= 20 ? 'chip-ok' : 'chip-warn'}`}>
                    {r1(reduction)}% 減（目標 20〜30%）
                  </span>
                )}
                {hasEstimate && (
                  <span className="sub">
                    全区間を概算で数えると {r0(estManual)}分 → {r0(estAi)}分
                  </span>
                )}
              </div>
              <Kpi label="移動距離" before={m.meters / 1000} after={a.meters / 1000} unit="km" />
              <Kpi label="交通費" before={m.fareYen} after={a.fareYen} unit="円" />
              <Kpi label="待ち時間" before={m.waitSeconds / 60} after={a.waitSeconds / 60} unit="分" />
              <Kpi label="条件違反" before={m.violations} after={a.violations} unit="件" />
            </div>
          </div>

          <div className="card stack">
            <h3>{terms.staff}ごとの比較（左：手作業案、右：AI案）</h3>
            {!views ? (
              <p className="sub">この結果は前の形式のため並べて表示できません。AI案を作り直してください。</p>
            ) : (
              <div className="compare">
                <div className="compare-row compare-header">
                  <div />
                  <div>手作業案（予定画面の割当）</div>
                  <div>AI案</div>
                </div>
                {staffIds.map((id) => {
                  const pm = m.perStaff[id];
                  const pa = a.perStaff[id];
                  const diff = r0(((pa?.travelSeconds ?? 0) - (pm?.travelSeconds ?? 0)) / 60);
                  return (
                    <div key={id} className="compare-row" style={{ borderTopColor: colorOfStaff.get(id) }}>
                      <button
                        type="button"
                        className={`compare-staff ${mapStaffId === id ? 'is-on' : ''}`}
                        onClick={() => setMapStaff(id)}
                        title="地図で見る"
                      >
                        <strong style={{ color: colorOfStaff.get(id) }}>{staffName(id)}</strong>
                        <span className="sub">
                          {pm?.visitCount ?? 0}件 → {pa?.visitCount ?? 0}件
                        </span>
                        <span className="sub">
                          移動 {r0((pm?.travelSeconds ?? 0) / 60)}分 → {r0((pa?.travelSeconds ?? 0) / 60)}分
                        </span>
                        <span className={`chip ${diff < 0 ? 'chip-ok' : diff > 0 ? 'chip-warn' : ''}`}>
                          {diff === 0 ? '差なし' : `${sign(diff)}分`}
                        </span>
                        {(pm?.violations ?? 0) + (pa?.violations ?? 0) > 0 && (
                          <span className="sub red-text">
                            条件違反 {pm?.violations ?? 0} → {pa?.violations ?? 0}
                          </span>
                        )}
                      </button>
                      <div className="compare-col">{stopCards(id, 'manual')}</div>
                      <div className="compare-col">{stopCards(id, 'ai')}</div>
                    </div>
                  );
                })}
              </div>
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
              <h3>地図：{mapStaffId ? staffName(mapStaffId) : ''}（点線：手作業、実線：AI）</h3>
              <span className="sub">上の比較で{terms.staff}の名前を押すと切り替わります</span>
            </div>
            <RouteMap points={points} lines={lines} height={400} />
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

function ownerMap(routes: Record<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [s, ids] of Object.entries(routes)) for (const id of ids) out.set(id, s);
  return out;
}

function Kpi({ label, before, after, unit }: { label: string; before: number; after: number; unit: string }) {
  return (
    <div className="kpi">
      <span className="sub">{label}</span>
      <span className="kpi-value">
        {r1(before)}
        {unit} →{' '}
        <strong>
          {r1(after)}
          {unit}
        </strong>
      </span>
      <span className="sub">{before === after ? '差なし' : `${sign(after - before)}${unit}`}</span>
    </div>
  );
}

/** 訪問のあいだの移動。地図APIの結果なら概算の値も並べる */
function Leg({
  minutes,
  estimate,
  from,
  warn = null,
}: {
  minutes: number;
  estimate: number | null;
  from: string | null;
  warn?: string | null;
}) {
  return (
    <div className={`leg-line ${warn ? 'red-text' : ''}`}>
      {from ? `${from} ` : '↓ 移動 '}
      {r0(minutes)}分{estimate !== null && <span className="sub">（概算 {r0(estimate)}分）</span>}
      {warn && `（${warn}）`}
    </div>
  );
}

/** 予定画面と同じ見た目の訪問カード */
function StopCard({
  stop,
  off,
  client,
  moved,
}: {
  stop: StopView;
  off: boolean;
  client: Client | undefined;
  moved: string | null;
}) {
  const red = stop.late || off;
  return (
    <div className={`route-item ${red ? 'is-red' : moved ? 'is-moved' : ''}`} style={{ cursor: 'default' }}>
      <div className={`sub nowrap ${stop.late ? 'red-text' : ''}`}>
        {minutesToHhmm(stop.start)}〜{minutesToHhmm(stop.end)}
        {stop.late && '（遅れ）'}
      </div>
      <ClientName client={client} />
      {moved && <span className="chip chip-move">{moved}</span>}
    </div>
  );
}
