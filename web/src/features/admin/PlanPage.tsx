import {
  type Client,
  DEFAULT_PLAN_PARAMS,
  jstDate,
  type ManualPlan,
  manualPlanSchema,
  minutesToHhmm,
  PLAN_PRESETS,
  type PlanMetrics,
  type PlanParams,
  type PlanPresetId,
  planParamsSchema,
  presetIdOf,
  type RouteView,
  type SolveResponse,
  type Staff,
  type StopView,
  type UnassignedReason,
  type Visit,
} from '@vrp/shared';
import { collection, doc, getDoc, getDocs, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MapLine, type MapPoint, RouteMap } from '../../components/RouteMap';
import { useToast } from '../../components/Toast';
import { call } from '../../lib/api';
import { colorOf, initialOf } from '../../lib/colors';
import { db } from '../../lib/firebase';
import { useSession } from '../../lib/session';
import { useOrgCollection, useOrgDoc, type WithId } from '../../lib/useCollection';
import { DateField, formError, hasLocation, staffColor, tomorrow, useAdmin } from './common';
import { ClientName } from './parts';

/**
 * AI案：パラメータを変えて作り、任意の2つを並べて比べる（ADR-0009）。
 * その日のAI案がまだ無ければ、第1プリセットで自動で作る（予定の割当が無ければ、それを予定にする）。
 * 担当ごとに1行で、左に案A、右に案Bを、予定画面と同じカードで並べる
 */

type PlanRun = {
  date: string;
  createdAt: number;
  mode: string;
  travelMode: string;
  computeMillis: number;
  solverVersion: string;
  /** 作ったときのパラメータ（ADR-0009 より前の結果には無い） */
  params?: PlanParams;
  presetId?: PlanPresetId | null;
  /** 移動時間に地図API（Google）の値を使ったか。古い結果には無い */
  mapsApi?: boolean;
  result: SolveResponse;
  metrics: { ai: PlanMetrics };
  /** 表示用の時刻と区間（古い結果には無い） */
  views?: { ai: Record<string, RouteView> };
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
const SIDE_COLORS = ['#4a7fc1', '#e8735f'] as const;

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const sign = (n: number) => (n > 0 ? `+${r1(n)}` : String(r1(n)));
const sumOf = (views: Record<string, RouteView>, f: (v: RouteView) => number | null) =>
  Object.values(views).reduce((t, v) => t + (f(v) ?? 0), 0);
const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

function presetLabel(r: PlanRun): string {
  if (!r.params) return '記録なし';
  const id = r.presetId ?? presetIdOf(r.params);
  return PLAN_PRESETS.find((p) => p.id === id)?.label ?? 'カスタム';
}
function paramsText(p: PlanParams | undefined): string {
  if (!p) return 'パラメータの記録なし（ADR-0009 より前の結果）';
  return [
    `待ちの重み ${p.waitWeight}`,
    `訪問のあいだの余裕 ${p.minGapMinutes}分`,
    `1人の上限 ${p.maxVisitsPerStaff === null ? 'なし' : `${p.maxVisitsPerStaff}件`}`,
    p.mapsApi ? 'Google の地図API' : '直線距離からの概算',
  ].join('・');
}

export default function PlanPage() {
  const { orgId, org, terms, isOperator } = useAdmin();
  const session = useSession();
  const toast = useToast();
  const [date, setDate] = useState(tomorrow);
  const runsQ = useOrgCollection<PlanRun>(orgId, 'planRuns', [where('date', '==', date)], date);
  const visitsQ = useOrgCollection<Visit>(orgId, 'visits', [where('date', '==', date)], date);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const planDoc = useOrgDoc<ManualPlan>(orgId, 'manualPlans', date);
  // 移動時間の求め方の既定は事業所の設定 useMapsApi（実測区間の予測も同じ設定を使う）
  const orgMaps = org ? org.useMapsApi !== false : null;
  const [params, setParams] = useState<PlanParams>(DEFAULT_PLAN_PARAMS);
  useEffect(() => {
    if (orgMaps !== null) setParams((p) => ({ ...p, mapsApi: orgMaps }));
  }, [orgMaps]);
  const paramsCheck = planParamsSchema.safeParse(params);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const [mapStaff, setMapStaff] = useState<string | null>(null);
  /** 自動で作った日（同じ日を何度も作らない） */
  const autoTried = useRef(new Set<string>());

  // 古い順に番号を付ける（#1 が自動で作った第1プリセットの案）
  const runs = useMemo(() => [...(runsQ.rows ?? [])].sort((a, b) => a.createdAt - b.createdAt), [runsQ.rows]);
  const numberOf = useMemo(() => new Map(runs.map((r, i) => [r.id, i + 1])), [runs]);
  const runLabel = (r: WithId<PlanRun>) =>
    `#${numberOf.get(r.id)} ${presetLabel(r)}（${timeOf(r.createdAt)}・${r.mapsApi ? 'Google' : '概算'}）`;
  const runA: WithId<PlanRun> | undefined = runs.find((r) => r.id === pickA) ?? runs[0];
  const runB: WithId<PlanRun> | undefined = runs.find((r) => r.id === pickB) ?? runs[runs.length - 1];
  const sides = useMemo(() => (runA && runB && runA.id !== runB.id ? [runA, runB] : runA ? [runA] : []), [runA, runB]);

  // 色は予定画面と同じ（名前の順）
  const staffSorted = useMemo(
    () => [...(staffQ.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const staffById = useMemo(() => new Map(staffSorted.map((s) => [s.id, s])), [staffSorted]);
  const colorOfStaff = useMemo(() => new Map(staffSorted.map((s, i) => [s.id, staffColor(i)])), [staffSorted]);
  const clientById = useMemo(() => new Map((clientsQ.rows ?? []).map((c) => [c.id, c])), [clientsQ.rows]);
  const visitById = useMemo(() => new Map((visitsQ.rows ?? []).map((v) => [v.id, v])), [visitsQ.rows]);

  const staffName = (id: string) => staffById.get(id)?.name ?? '（不明）';
  const clientOf = (visitId: string) => {
    const v = visitById.get(visitId);
    return v ? clientById.get(v.clientId) : undefined;
  };
  const visitLabel = (id: string) =>
    `${visitById.get(id)?.earliestStart ?? ''} ${clientOf(id)?.displayName ?? '（不明）'}`;

  /** AI案の担当と順番を、その日の予定（手作業案の置き場所と訪問の担当）に書く */
  const adopt = useCallback(
    async (runId: string, run: PlanRun, visits: WithId<Visit>[]) => {
      const routes: Record<string, string[]> = {};
      for (const r of run.result.routes) if (r.stops.length > 0) routes[r.staffId] = r.stops.map((s) => s.visitId);
      const owner = ownerMap(routes);
      const data = manualPlanSchema.parse({
        date: run.date,
        routes,
        minutesSpent: null,
        fromRunId: runId,
        updatedBy: session.user.uid,
        updatedAt: Date.now(),
      });
      const batch = writeBatch(db);
      batch.set(doc(db, 'orgs', orgId, 'manualPlans', run.date), data);
      // AI案に入った訪問だけ担当を書く（AI案の後に足した訪問・割り当てられなかった訪問の担当は今のまま）
      for (const v of visits) {
        const next = owner.get(v.id);
        if (v.cancelled || !next) continue;
        if (v.staffId !== next) batch.update(doc(db, 'orgs', orgId, 'visits', v.id), { staffId: next });
      }
      await batch.commit();
    },
    [orgId, session.user.uid],
  );

  const create = useCallback(
    async (p: PlanParams, auto: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const { runId } = await call('createPlanRun', {
          date,
          requestId: crypto.randomUUID(),
          orgId: isOperator ? orgId : null,
          params: p,
        });
        setPickB(runId);
        if (!auto) {
          toast('AI案を作成しました');
          return;
        }
        // 自動で作った案は、その日の割当がまだ何も無ければ予定にする（スタッフの画面に出る）。
        // 画面の購読は日付の切り替え直後に前の日の値が残ることがあるので、その日の訪問を読み直す
        const visits = (
          await getDocs(query(collection(db, 'orgs', orgId, 'visits'), where('date', '==', date)))
        ).docs.map((d) => ({ id: d.id, ...(d.data() as Visit) }));
        const plan = await getDoc(doc(db, 'orgs', orgId, 'manualPlans', date));
        const run = await getDoc(doc(db, 'orgs', orgId, 'planRuns', runId));
        const unassigned = !plan.exists() && visits.every((v) => v.cancelled || !v.staffId);
        if (unassigned && run.exists()) {
          await adopt(runId, run.data() as PlanRun, visits);
          toast(`第1プリセット（${PLAN_PRESETS[0]?.label}）でAI案を作り、予定にしました`);
        } else {
          toast(`第1プリセット（${PLAN_PRESETS[0]?.label}）でAI案を作りました`);
        }
      } catch (e) {
        setError(formError(e));
      } finally {
        setBusy(false);
      }
    },
    [date, orgId, isOperator, toast, adopt],
  );

  // きょう以降で、その日のAI案が無く訪問があれば、第1プリセットで自動で作る。
  // 順番だけのモード（order_only）は担当が要るので作らない。購読が前の日の値のままなら待つ
  const autoReady =
    !busy &&
    org !== null &&
    org.optimizeMode === 'assign_and_order' &&
    date >= jstDate(Date.now()) &&
    runsQ.rows !== null &&
    visitsQ.rows !== null &&
    runsQ.rows.every((r) => r.date === date) &&
    visitsQ.rows.every((v) => v.date === date);
  const autoNeeded = autoReady && runsQ.rows?.length === 0 && (visitsQ.rows?.some((v) => !v.cancelled) ?? false);
  useEffect(() => {
    if (!autoNeeded || orgMaps === null || autoTried.current.has(date)) return;
    autoTried.current.add(date);
    void create({ ...DEFAULT_PLAN_PARAMS, mapsApi: orgMaps }, true);
  }, [autoNeeded, orgMaps, date, create]);

  const changeDate = (d: string) => {
    setDate(d);
    setPickA(null);
    setPickB(null);
  };

  const adoptClick = async (run: WithId<PlanRun>) => {
    const past = run.date < jstDate(Date.now());
    const hasPlan = (await getDoc(doc(db, 'orgs', orgId, 'manualPlans', run.date))).exists();
    if (
      (past || hasPlan) &&
      !window.confirm(
        past
          ? '過ぎた日の予定の割当を、この AI案で置き換えます（記録・勤怠とずれることがあります）。よろしいですか？'
          : 'この日の予定の割当を、この AI案で置き換えます。よろしいですか？',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await adopt(run.id, run, visitsQ.rows ?? []);
      toast(`${runLabel(run)} を予定にしました`);
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  const routesA = useMemo(() => routesOfRun(runA), [runA]);
  const routesB = useMemo(() => routesOfRun(runB), [runB]);
  const ownerA = useMemo(() => ownerMap(routesA), [routesA]);
  const ownerB = useMemo(() => ownerMap(routesB), [routesB]);

  // 担当：どちらかの案に訪問のある人（予定画面と同じ順）
  const staffIds = useMemo(() => {
    const ids = new Set(
      [...Object.entries(routesA), ...Object.entries(routesB)].filter(([, v]) => v.length > 0).map(([k]) => k),
    );
    const order = staffSorted.map((s) => s.id).filter((id) => ids.has(id));
    return [...order, ...[...ids].filter((id) => !order.includes(id))];
  }, [routesA, routesB, staffSorted]);
  const mapStaffId = mapStaff && staffIds.includes(mapStaff) ? mapStaff : (staffIds[0] ?? null);

  const { points, lines } = useMemo(() => {
    const pts: MapPoint[] = [];
    const lns: MapLine[] = [];
    if (!mapStaffId) return { points: pts, lines: lns };
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
    lns.push({ points: pathOf(routesA[mapStaffId] ?? []), color: SIDE_COLORS[0], dashed: sides.length > 1 });
    if (sides.length > 1) lns.push({ points: pathOf(routesB[mapStaffId] ?? []), color: SIDE_COLORS[1] });
    return { points: pts, lines: lns };
  }, [mapStaffId, staffById, visitById, clientById, routesA, routesB, sides.length]);

  /** 案Aと案Bで担当が違う訪問の印 */
  const movedLabel = (visitId: string, staffId: string, side: number): string | null => {
    if (sides.length < 2) return null;
    const other = side === 0 ? ownerB : ownerA;
    const name = side === 0 ? 'B' : 'A';
    const o = other.get(visitId);
    if (o === staffId) return null;
    return o ? `${name}では ${staffName(o)}` : `${name}では未割当`;
  };

  const stopCards = (run: PlanRun, staffId: string, side: number) => {
    const view = run.views?.ai[staffId];
    if (!view) return <span className="sub">訪問なし</span>;
    const hasEstimate = run.mapsApi === true;
    return (
      <div className="stack" style={{ gap: 0 }}>
        {view.stops.map((s, i) => (
          <div key={s.visitId}>
            <Leg
              minutes={s.travelMinutes}
              estimate={hasEstimate ? s.estimateMinutes : null}
              from={i === 0 ? '自宅から' : null}
            />
            <StopCard stop={s} client={clientOf(s.visitId)} moved={movedLabel(s.visitId, staffId, side)} />
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

  const presetNow = presetIdOf(params);
  /** 移動時間の求め方を変えると、事業所の設定（実測区間の予測・次の自動作成の既定）も変える */
  const setMaps = async (v: boolean) => {
    setParams({ ...params, mapsApi: v });
    try {
      await updateDoc(doc(db, 'orgs', orgId), { useMapsApi: v });
    } catch (e) {
      setError(formError(e));
    }
  };
  const setNum = (k: 'waitWeight' | 'minGapMinutes', v: string) => {
    const n = Number(v);
    if (v !== '' && Number.isFinite(n)) setParams({ ...params, [k]: n });
  };
  const cols = `170px repeat(${sides.length}, minmax(0, 1fr))`;
  const ma = runA?.metrics.ai;
  const mb = sides.length > 1 ? runB?.metrics.ai : undefined;

  return (
    <div className="stack">
      <h2>AI案</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={changeDate} />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="sub">プリセット：</span>
            <div className="segmented">
              {PLAN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={presetNow === p.id}
                  className={presetNow === p.id ? 'is-on' : ''}
                  onClick={() => setParams({ ...p.params, mapsApi: params.mapsApi })}
                  title={p.description}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {presetNow === null && <span className="chip">カスタム</span>}
          </div>
          <div className="method-help">
            {PLAN_PRESETS.map((p) => (
              <div key={p.id}>
                <strong>{p.label}</strong>：{p.description}
              </div>
            ))}
          </div>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ maxWidth: 170 }}>
              待ち時間の重み（移動=1）
              <input
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={params.waitWeight}
                onChange={(e) => setNum('waitWeight', e.target.value)}
              />
            </label>
            <label style={{ maxWidth: 170 }}>
              訪問のあいだの余裕（分）
              <input
                type="number"
                min={0}
                max={60}
                step={5}
                value={params.minGapMinutes}
                onChange={(e) => setNum('minGapMinutes', e.target.value)}
              />
            </label>
            <label style={{ maxWidth: 170 }}>
              1人の件数の上限（空欄=なし）
              <input
                type="number"
                min={1}
                max={30}
                value={params.maxVisitsPerStaff ?? ''}
                onChange={(e) =>
                  setParams({ ...params, maxVisitsPerStaff: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="sub">移動時間の求め方：</span>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={params.mapsApi}
                className={params.mapsApi ? 'is-on' : ''}
                onClick={() => setMaps(true)}
              >
                Google の地図API
              </button>
              <button
                type="button"
                aria-pressed={!params.mapsApi}
                className={params.mapsApi ? '' : 'is-on'}
                onClick={() => setMaps(false)}
              >
                直線距離からの概算（無料）
              </button>
            </div>
          </div>
          <div className="method-help">
            <div>
              <strong>Google の地図API</strong>
              ：実際の道路の経路と、出発する時間帯の混み具合から車の所要時間を出します。
              使った区間の数だけ費用がかかります（同じ区間は30日間使い回します）。近い10か所どうしの区間だけを聞き、残りは概算を補正して埋めます。Google
              で測った区間には、同じ区間の概算を「（概算 ◯分）」と並べます。
            </div>
            <div>
              <strong>直線距離からの概算</strong>
              ：2地点の直線距離を1.3倍して道のりとし、時速25kmで割った時間です。川・山・一方通行・渋滞を知らないので、回り道の多い区間ではずれます。
            </div>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !paramsCheck.success}
              onClick={() => create(params, false)}
            >
              {busy ? '作成中…（数十秒かかります）' : 'このパラメータでAI案を作成'}
            </button>
            {!paramsCheck.success && (
              <span className="error">
                待ちの重みは0〜5、余裕は0〜60分の整数、件数の上限は1〜30の整数（空欄はなし）で入力してください
              </span>
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {runsQ.rows === null ? (
        <p className="sub">読み込み中…</p>
      ) : !runA || !ma ? (
        <p className="sub">
          {visitsQ.rows?.some((v) => !v.cancelled)
            ? busy
              ? '第1プリセットでAI案を作成しています…'
              : 'この日のAI案はまだありません。'
            : 'この日の訪問がありません。'}
        </p>
      ) : (
        <>
          <div className="card stack">
            <div className="spread" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <h3>AI案の比較</h3>
              <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {(['A', 'B'] as const).map((name) => {
                  const cur = name === 'A' ? runA : runB;
                  return (
                    <label key={name} style={{ maxWidth: 320 }}>
                      案{name}
                      <select
                        value={cur?.id ?? ''}
                        onChange={(e) => (name === 'A' ? setPickA : setPickB)(e.target.value)}
                      >
                        {runs.map((r) => (
                          <option key={r.id} value={r.id}>
                            {runLabel(r)}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
            {sides.length < 2 && (
              <p className="sub">
                {runs.length < 2
                  ? 'パラメータを変えて作成すると、2つの案を並べて比べられます。'
                  : '案Aと案Bに別の案を選ぶと並べて比べられます。'}
              </p>
            )}
            <div className="stack" style={{ gap: 4 }}>
              {sides.map((r, i) => (
                <div key={r.id} className="row" style={{ flexWrap: 'wrap' }}>
                  <strong style={{ color: SIDE_COLORS[i] }}>案{i === 0 ? 'A' : 'B'}</strong>
                  <span>{runLabel(r)}</span>
                  <span className="sub">
                    {paramsText(r.params)} ／ 計算 {r1(r.computeMillis / 1000)}秒
                  </span>
                  {planDoc?.fromRunId === r.id ? (
                    <span className="chip chip-ok">予定に採用中</span>
                  ) : (
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => adoptClick(r)}>
                      この案を予定にする
                    </button>
                  )}
                </div>
              ))}
            </div>
            {mb && runB ? (
              <div className="kpi-row">
                <Kpi
                  label="移動時間の合計"
                  before={ma.travelSeconds / 60}
                  after={mb.travelSeconds / 60}
                  unit="分"
                  note={
                    runA.mapsApi && runB.mapsApi && runA.views && runB.views
                      ? `全区間を概算で数えると ${r0(sumOf(runA.views.ai, (v) => v.estimateTravelMinutes))}分 → ${r0(sumOf(runB.views.ai, (v) => v.estimateTravelMinutes))}分`
                      : runA.mapsApi !== runB.mapsApi
                        ? '移動時間の求め方が違うため、そのままは比べられません'
                        : null
                  }
                />
                <Kpi label="移動距離" before={ma.meters / 1000} after={mb.meters / 1000} unit="km" />
                <Kpi label="交通費" before={ma.fareYen} after={mb.fareYen} unit="円" />
                <Kpi label="待ち時間" before={ma.waitSeconds / 60} after={mb.waitSeconds / 60} unit="分" />
                <Kpi label="条件違反" before={ma.violations} after={mb.violations} unit="件" />
                <Kpi
                  label="割り当てられない訪問"
                  before={runA.result.unassigned.length}
                  after={runB.result.unassigned.length}
                  unit="件"
                />
              </div>
            ) : (
              <div className="kpi-row">
                <Single label="移動時間の合計" value={ma.travelSeconds / 60} unit="分" />
                <Single label="移動距離" value={ma.meters / 1000} unit="km" />
                <Single label="交通費" value={ma.fareYen} unit="円" />
                <Single label="待ち時間" value={ma.waitSeconds / 60} unit="分" />
                <Single label="条件違反" value={ma.violations} unit="件" />
                <Single label="割り当てられない訪問" value={runA.result.unassigned.length} unit="件" />
              </div>
            )}
          </div>

          <div className="card stack">
            <h3>
              {terms.staff}ごとの{sides.length > 1 ? '比較（左：案A、右：案B）' : '割当と順番'}
            </h3>
            {sides.some((r) => !r.views) ? (
              <p className="sub">前の形式の結果は並べて表示できません。AI案を作り直してください。</p>
            ) : (
              <div className="compare">
                <div className="compare-row compare-header" style={{ gridTemplateColumns: cols }}>
                  <div />
                  {sides.map((r, i) => (
                    <div key={r.id} style={{ color: SIDE_COLORS[i] }}>
                      案{i === 0 ? 'A' : 'B'}：{runLabel(r)}
                    </div>
                  ))}
                </div>
                {staffIds.map((id) => {
                  const pa = ma.perStaff[id];
                  const pb = mb?.perStaff[id];
                  const diff = r0(((pb?.travelSeconds ?? 0) - (pa?.travelSeconds ?? 0)) / 60);
                  return (
                    <div
                      key={id}
                      className="compare-row"
                      style={{ borderTopColor: colorOfStaff.get(id), gridTemplateColumns: cols }}
                    >
                      <button
                        type="button"
                        className={`compare-staff ${mapStaffId === id ? 'is-on' : ''}`}
                        onClick={() => setMapStaff(id)}
                        title="地図で見る"
                      >
                        <strong style={{ color: colorOfStaff.get(id) }}>{staffName(id)}</strong>
                        {mb ? (
                          <>
                            <span className="sub">
                              {pa?.visitCount ?? 0}件 → {pb?.visitCount ?? 0}件
                            </span>
                            <span className="sub">
                              移動 {r0((pa?.travelSeconds ?? 0) / 60)}分 → {r0((pb?.travelSeconds ?? 0) / 60)}分
                            </span>
                            <span className={`chip ${diff < 0 ? 'chip-ok' : diff > 0 ? 'chip-warn' : ''}`}>
                              {diff === 0 ? '差なし' : `${sign(diff)}分`}
                            </span>
                          </>
                        ) : (
                          <span className="sub">
                            {pa?.visitCount ?? 0}件・移動 {r0((pa?.travelSeconds ?? 0) / 60)}分
                          </span>
                        )}
                      </button>
                      {sides.map((r, i) => (
                        <div key={r.id} className="compare-col">
                          {stopCards(r, id, i)}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {sides.some((r) => r.result.unassigned.length > 0) && (
            <div className="card stack">
              <h3>割り当てられなかった訪問</h3>
              {sides.map((r, i) =>
                r.result.unassigned.map((u) => (
                  <div key={`${r.id}:${u.visitId}`} className="row" style={{ flexWrap: 'wrap' }}>
                    <strong style={{ color: SIDE_COLORS[i] }}>案{i === 0 ? 'A' : 'B'}</strong>
                    <span>{visitLabel(u.visitId)}</span>
                    {u.reasons.map((x) => (
                      <span key={x} className="chip chip-warn">
                        {REASON_LABELS[x]}
                      </span>
                    ))}
                  </div>
                )),
              )}
            </div>
          )}

          {runA.skipped.length > 0 && (
            <div className="card stack">
              <h3>計算に入れなかったもの</h3>
              {runA.skipped.map((s) => (
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
              <h3>
                地図：{mapStaffId ? staffName(mapStaffId) : ''}
                {sides.length > 1 && '（点線：案A、実線：案B）'}
              </h3>
              <span className="sub">上の比較で{terms.staff}の名前を押すと切り替わります</span>
            </div>
            <RouteMap points={points} lines={lines} height={400} />
            {sides.length > 1 && (
              <div className="row sub">
                <span style={{ color: SIDE_COLORS[0] }}>- - - 案A</span>
                <span style={{ color: SIDE_COLORS[1] }}>━━ 案B</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function routesOfRun(r: PlanRun | undefined): Record<string, string[]> {
  return Object.fromEntries((r?.result.routes ?? []).map((x) => [x.staffId, x.stops.map((s) => s.visitId)]));
}

function ownerMap(routes: Record<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [s, ids] of Object.entries(routes)) for (const id of ids) out.set(id, s);
  return out;
}

function Kpi({
  label,
  before,
  after,
  unit,
  note = null,
}: {
  label: string;
  before: number;
  after: number;
  unit: string;
  note?: string | null;
}) {
  return (
    <div className="kpi">
      <span className="sub">{label}（A → B）</span>
      <span className="kpi-value">
        {r1(before)}
        {unit} →{' '}
        <strong>
          {r1(after)}
          {unit}
        </strong>
      </span>
      <span className="sub">{before === after ? '差なし' : `${sign(after - before)}${unit}`}</span>
      {note && <span className="sub">{note}</span>}
    </div>
  );
}

function Single({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="kpi">
      <span className="sub">{label}</span>
      <span className="kpi-value">
        <strong>
          {r1(value)}
          {unit}
        </strong>
      </span>
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
function StopCard({ stop, client, moved }: { stop: StopView; client: Client | undefined; moved: string | null }) {
  return (
    <div className={`route-item ${stop.late ? 'is-red' : moved ? 'is-moved' : ''}`} style={{ cursor: 'default' }}>
      <div className={`sub nowrap ${stop.late ? 'red-text' : ''}`}>
        {minutesToHhmm(stop.start)}〜{minutesToHhmm(stop.end)}
        {stop.late && '（遅れ）'}
      </div>
      <ClientName client={client} />
      {moved && <span className="chip chip-move">{moved}</span>}
    </div>
  );
}
