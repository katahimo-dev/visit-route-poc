import {
  type Client,
  type ClientPrivate,
  type ManualPlan,
  manualPlanSchema,
  type Staff,
  type Visit,
  visitSchema,
  weekday,
} from '@vrp/shared';
import { collection, doc, getDoc, getDocs, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { type MapLine, type MapPoint, RouteMap } from '../../../components/RouteMap';
import { useToast } from '../../../components/Toast';
import { colorOf, initialOf } from '../../../lib/colors';
import { db } from '../../../lib/firebase';
import { useSession } from '../../../lib/session';
import { useOrgCollection, useOrgDoc, type WithId } from '../../../lib/useCollection';
import { addDays, DateField, formError, hasLocation, staffColor, tomorrow, useAdmin, WEEKDAY_LABELS } from '../common';
import {
  assign,
  type Cols,
  isTimeOrdered,
  NONE,
  reconcile,
  type Slot,
  shift,
  slotsOf,
  sortByTime,
  type View,
  WARNING_LABELS,
  warningsOf,
  windowText,
} from './model';
import { VisitForm } from './VisitForm';

/**
 * 予定＝その日の訪問と手作業案。
 * 上の一覧で訪問ごとに担当を選び、下の担当ごとの列で回る順番を決める（どちらも保存するまでは下書き）
 */
export default function SchedulePage() {
  const { orgId, terms } = useAdmin();
  const session = useSession();
  const toast = useToast();
  const [date, setDate] = useState(tomorrow);
  const visitsQ = useOrgCollection<Visit>(orgId, 'visits', [where('date', '==', date)], date);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const privateQ = useOrgCollection<ClientPrivate>(orgId, 'clientPrivate');
  const planDoc = useOrgDoc<ManualPlan>(orgId, 'manualPlans', date);
  const [draft, setDraft] = useState<Cols | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
  /** 開いている入力欄（null：閉じている、'new'：足す、それ以外：直す訪問の ID） */
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 日付を変えたら編集中の内容を捨てる
  useEffect(() => {
    setDraft(null);
    setMinutes(null);
    setEditing(null);
    setError(null);
  }, [date]);

  const allVisits = visitsQ.rows;
  const visits = useMemo(() => (allVisits ?? []).filter((v) => !v.cancelled), [allVisits]);
  const staff = useMemo(
    () => [...(staffQ.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const clients = useMemo(
    () => [...(clientsQ.rows ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja')),
    [clientsQ.rows],
  );
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const colorOfStaff = useMemo(() => new Map(staff.map((s, i) => [s.id, staffColor(i)])), [staff]);
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const ngById = useMemo(() => new Map((privateQ.rows ?? []).map((p) => [p.id, p.ngStaffIds])), [privateQ.rows]);
  const visitById = useMemo(() => new Map(visits.map((v) => [v.id, v])), [visits]);
  const plan = planDoc && planDoc.date === date ? planDoc : null;

  const view = useMemo(
    () =>
      reconcile(
        draft ?? plan?.routes ?? {},
        visits,
        staff.map((s) => s.id),
      ),
    [draft, plan, visits, staff],
  );
  const setView = (v: View) => setDraft({ ...v.cols, [NONE]: v.unassigned });
  const ownerOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [s, ids] of Object.entries(view.cols)) for (const id of ids) m.set(id, s);
    return m;
  }, [view]);
  const slots = useMemo(() => {
    const m = new Map<string, Slot>();
    for (const ids of Object.values(view.cols)) for (const [id, s] of slotsOf(ids, visitById)) m.set(id, s);
    return m;
  }, [view, visitById]);

  const dow = weekday(date);
  const worksToday = (s: Staff) => s.active && s.workDays.includes(dow);
  /** 担当に選べる人：勤務日の人を先に、休みの人は後ろ（休止中の人は、すでに担当している訪問があるときだけ） */
  const choosable = [...staff.filter(worksToday), ...staff.filter((s) => s.active && !worksToday(s))];
  /** 列を出す人：勤務日の人と、担当の訪問がある人 */
  const columns = staff.filter((s) => worksToday(s) || (view.cols[s.id]?.length ?? 0) > 0);
  const sortedVisits = [...visits].sort(
    (a, b) => a.earliestStart.localeCompare(b.earliestStart) || a.latestStart.localeCompare(b.latestStart),
  );

  const minutesValue = minutes ?? (plan?.minutesSpent != null ? String(plan.minutesSpent) : '');
  const dirty = draft !== null || minutes !== null;
  const discard = () => {
    setDraft(null);
    setMinutes(null);
  };

  const savePlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = minutesValue.trim();
      const routes: Cols = {};
      for (const [k, ids] of Object.entries(view.cols)) if (ids.length > 0) routes[k] = ids;
      const data = manualPlanSchema.parse({
        date,
        routes,
        minutesSpent: m === '' ? null : Number(m),
        updatedBy: session.user.uid,
        updatedAt: Date.now(),
      });
      const batch = writeBatch(db);
      batch.set(doc(db, 'orgs', orgId, 'manualPlans', date), data);
      for (const v of visits) {
        const next = ownerOf.get(v.id) ?? null;
        if ((v.staffId ?? null) !== next) batch.update(doc(db, 'orgs', orgId, 'visits', v.id), { staffId: next });
      }
      await batch.commit();
      discard();
      toast('手作業案を保存しました');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelVisit = async (v: WithId<Visit>) => {
    if (!confirm('この訪問を取り消しますか？')) return;
    try {
      await updateDoc(doc(db, 'orgs', orgId, 'visits', v.id), { cancelled: true });
      toast('取り消しました');
    } catch (e) {
      setError(formError(e));
    }
  };

  const copyFromLastWeek = async () => {
    const from = addDays(date, -7);
    if (!confirm(`${from} の予定（と手作業案）を ${date} にコピーします。よろしいですか？`)) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await getDocs(query(collection(db, 'orgs', orgId, 'visits'), where('date', '==', from)));
      const src = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Visit) })).filter((v) => !v.cancelled);
      if (src.length === 0) {
        setError(`${from} にコピーできる訪問がありません`);
        return;
      }
      const oldPlan = await getDoc(doc(db, 'orgs', orgId, 'manualPlans', from));
      const idMap = new Map<string, string>(src.map((v) => [v.id, crypto.randomUUID()]));
      const batch = writeBatch(db);
      for (const v of src) {
        const { id: _id, ...rest } = v;
        batch.set(
          doc(db, 'orgs', orgId, 'visits', idMap.get(v.id) as string),
          visitSchema.parse({ ...rest, date, cancelled: false }),
        );
      }
      const routes: Cols = {};
      if (oldPlan.exists()) {
        for (const [s, ids] of Object.entries((oldPlan.data() as ManualPlan).routes)) {
          const mapped = ids.map((id) => idMap.get(id)).filter((x): x is string => !!x);
          if (mapped.length > 0) routes[s] = mapped;
        }
      }
      batch.set(
        doc(db, 'orgs', orgId, 'manualPlans', date),
        manualPlanSchema.parse({
          date,
          routes,
          minutesSpent: null,
          updatedBy: session.user.uid,
          updatedAt: Date.now(),
        }),
      );
      await batch.commit();
      toast(`${src.length}件コピーしました`);
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  // 地図：担当ごとの手作業ルート（点線、列と同じ色）
  const { points, lines } = useMemo(() => {
    const pts: MapPoint[] = [];
    const lns: MapLine[] = [];
    for (const s of staff) {
      const ids = view.cols[s.id] ?? [];
      if (ids.length === 0) continue;
      const color = colorOfStaff.get(s.id) ?? staffColor(0);
      const path: { lat: number; lng: number }[] = [];
      const home = hasLocation(s.home) ? { lat: s.home.lat, lng: s.home.lng } : null;
      if (home) {
        path.push(home);
        pts.push({ ...home, label: '家', color });
      }
      for (const id of ids) {
        const v = visitById.get(id);
        const c = v && clientById.get(v.clientId);
        if (!c || !hasLocation(c.place)) continue;
        path.push({ lat: c.place.lat, lng: c.place.lng });
        pts.push({ lat: c.place.lat, lng: c.place.lng, label: initialOf(c.displayName), color: colorOf(c.color) });
      }
      if (home && path.length > 1) path.push(home);
      lns.push({ points: path, color, dashed: true });
    }
    return { points: pts, lines: lns };
  }, [staff, view, visitById, clientById, colorOfStaff]);

  const clientCell = (v: Visit) => {
    const c = clientById.get(v.clientId);
    return (
      <div className="visit-name">
        <span className="dot dot-sm" style={{ background: colorOf(c?.color ?? 0) }}>
          {initialOf(c?.displayName ?? '?')}
        </span>
        <span className="ellipsis">{c?.displayName ?? '（不明）'}</span>
      </div>
    );
  };

  const editingVisit = editing && editing !== 'new' ? (visitById.get(editing) ?? null) : null;

  return (
    <div className="stack">
      <h2>予定</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={setDate} />
          <span className="sub" style={{ paddingBottom: 12 }}>
            （{WEEKDAY_LABELS[dow]}）
          </span>
          <button type="button" className="btn" onClick={() => setEditing('new')} disabled={clients.length === 0}>
            訪問を足す
          </button>
          <button
            type="button"
            className="btn"
            onClick={copyFromLastWeek}
            disabled={busy || visits.length > 0 || allVisits === null}
            title={visits.length > 0 ? 'この日に訪問があるときはコピーできません' : ''}
          >
            前の同じ曜日からコピー
          </button>
        </div>
        {clients.length === 0 && clientsQ.rows && <p className="sub">先に{terms.client}を登録してください。</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {editing && (
        <VisitForm key={editing} date={date} visit={editingVisit} clients={clients} onClose={() => setEditing(null)} />
      )}

      {allVisits === null ? (
        <p className="sub">読み込み中…</p>
      ) : visits.length === 0 ? (
        <div className="card">
          <p className="sub">この日の訪問はまだありません。</p>
        </div>
      ) : (
        <>
          <div className="card stack">
            <div className="spread">
              <h3>
                訪問の一覧（{visits.length}件
                {view.unassigned.length > 0 && <span className="warn-text">・未割当 {view.unassigned.length}件</span>}）
              </h3>
              {dirty && <span className="chip chip-warn">未保存の変更があります</span>}
            </div>
            <p className="sub">訪問ごとに担当の{terms.staff}を選ぶと、下の「回る順番」に入ります。</p>
            <div className="table-scroll">
              <table className="visit-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>{terms.client}</th>
                    <th className="num">所要</th>
                    <th>担当</th>
                    <th>気をつけること</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedVisits.map((v) => {
                    const owner = ownerOf.get(v.id) ?? null;
                    const warnings = warningsOf(
                      date,
                      owner ? staffById.get(owner) : undefined,
                      owner,
                      clientById.get(v.clientId),
                      ngById.get(v.clientId) ?? [],
                      slots.get(v.id),
                    );
                    return (
                      <tr key={v.id} className={owner ? '' : 'row-unassigned'}>
                        <td className="nowrap">
                          {windowText(v)}
                          {v.windowKind === 'window' && <div className="sub">に開始</div>}
                        </td>
                        <td>
                          {clientCell(v)}
                          {v.note && <div className="sub">{v.note}</div>}
                        </td>
                        <td className="num nowrap">{v.durationMinutes}分</td>
                        <td>
                          <select
                            className="staff-select"
                            value={owner ?? NONE}
                            style={{ borderLeftColor: owner ? colorOfStaff.get(owner) : 'var(--warn)' }}
                            onChange={(e) => setView(assign(view, v.id, e.target.value, visitById))}
                            aria-label="担当"
                          >
                            <option value={NONE}>未割当</option>
                            {choosable.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                                {worksToday(s) ? '' : '（休み）'}
                              </option>
                            ))}
                            {owner && !choosable.some((s) => s.id === owner) && (
                              <option value={owner}>{staffById.get(owner)?.name ?? '（不明）'}（休止中）</option>
                            )}
                          </select>
                        </td>
                        <td>
                          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                            {warnings.map((w) => (
                              <span key={w} className="chip chip-warn">
                                {WARNING_LABELS[w]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="nowrap">
                          <button type="button" className="btn btn-small" onClick={() => setEditing(v.id)}>
                            直す
                          </button>{' '}
                          <button type="button" className="btn btn-small" onClick={() => cancelVisit(v)}>
                            取り消す
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card stack">
            <h3>回る順番（{terms.staff}ごと）</h3>
            <p className="sub">▲▼で順番を入れ替えます。時刻は移動時間を入れない目安です。</p>
            <div className="route-grid">
              {columns.map((s) => {
                const ids = view.cols[s.id] ?? [];
                const first = slots.get(ids[0] ?? '');
                const last = slots.get(ids[ids.length - 1] ?? '');
                return (
                  <div key={s.id} className="route-col" style={{ borderTopColor: colorOfStaff.get(s.id) }}>
                    <div className="spread">
                      <strong className="ellipsis">{s.name}</strong>
                      <span className="sub nowrap">
                        {ids.length}件{first && last ? `・${first.start}〜${last.end}` : ''}
                      </span>
                    </div>
                    {!worksToday(s) && <span className="chip chip-warn">{s.active ? '勤務日ではない' : '休止中'}</span>}
                    {ids.length === 0 && <span className="sub">訪問なし</span>}
                    {ids.map((id, idx) => {
                      const v = visitById.get(id);
                      const slot = slots.get(id);
                      if (!v) return null;
                      return (
                        <div key={id} className="route-item">
                          <span className="sub">{idx + 1}</span>
                          <div style={{ minWidth: 0 }}>
                            <div className={`sub nowrap ${slot?.late ? 'warn-text' : ''}`}>
                              {slot ? `${slot.start}〜${slot.end}` : v.earliestStart}
                              {slot?.late && '（遅れ）'}
                            </div>
                            {clientCell(v)}
                          </div>
                          <div className="route-move">
                            <button
                              type="button"
                              className="btn btn-icon"
                              disabled={idx === 0}
                              onClick={() => setView(shift(view, s.id, idx, -1))}
                              aria-label="上へ"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon"
                              disabled={idx === ids.length - 1}
                              onClick={() => setView(shift(view, s.id, idx, 1))}
                              aria-label="下へ"
                            >
                              ▼
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {!isTimeOrdered(ids, visitById) && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setView(sortByTime(view, s.id, visitById))}
                      >
                        時刻の順に並べ直す
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="card stack">
              <h3>手作業案の地図（点線：{terms.staff}ごとのルート、「家」は自宅）</h3>
              <RouteMap points={points} lines={lines} height={360} />
              <div className="row sub" style={{ flexWrap: 'wrap' }}>
                {columns
                  .filter((s) => (view.cols[s.id]?.length ?? 0) > 0)
                  .map((s) => (
                    <span key={s.id} className="nowrap">
                      <span style={{ color: colorOfStaff.get(s.id) }}>━</span> {s.name}
                    </span>
                  ))}
              </div>
            </div>
          )}

          <div className="savebar">
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <span className="nowrap">ルート作成にかかった時間</span>
              <input
                type="number"
                min={0}
                max={1440}
                value={minutesValue}
                onChange={(e) => setMinutes(e.target.value)}
                style={{ width: 90 }}
              />
              分
            </label>
            <span className="grow sub">保存すると、各訪問の担当もこのとおりに変わります。</span>
            {dirty && (
              <button type="button" className="btn" onClick={discard}>
                変更をもどす
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={savePlan}>
              手作業案を保存
            </button>
          </div>
        </>
      )}
    </div>
  );
}
