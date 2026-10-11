import {
  type Availability,
  availabilityOf,
  type Client,
  type ClientPrivate,
  type ManualPlan,
  manualPlanSchema,
  type Staff,
  slotsText,
  type Visit,
  visitSchema,
  weekday,
} from '@vrp/shared';
import { collection, doc, getDoc, getDocs, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { type DragEvent, useEffect, useMemo, useState } from 'react';
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
  hhmm,
  isRed,
  NONE,
  reconcile,
  type Slotted,
  timeOrder,
  timesOf,
  type View,
  WARNING_LABELS,
  type Warning,
  warningsOf,
  windowText,
} from './model';
import { VisitForm } from './VisitForm';

/**
 * 予定＝その日の訪問と手作業案（担当の割当）。
 * 上の一覧で担当を選ぶか、下の担当ごとの列のあいだで訪問をドラッグして移す（保存するまでは下書き）。
 * 回る順番は開始時刻の順（PRD R3）。時間の重なり・稼働時間外は赤い枠で知らせ、保存は止めない
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
  const availQ = useOrgCollection<Availability>(orgId, 'availability', [where('date', '==', date)], date);
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

  const dow = weekday(date);
  /** その日の稼働時間帯（基本の曜日と時間＋日ごとの上書き。ADR-0008） */
  const slotsOf = useMemo(() => {
    const overrides = new Map((availQ.rows ?? []).map((a) => [a.staffId, a]));
    return new Map(staff.map((s) => [s.id, availabilityOf(s, date, overrides.get(s.id))]));
  }, [staff, availQ.rows, date]);
  const times = useMemo(() => {
    const m = new Map<string, Slotted>();
    for (const [sid, ids] of Object.entries(view.cols))
      for (const [id, t] of timesOf(ids, visitById, slotsOf.get(sid)?.slots)) m.set(id, t);
    return m;
  }, [view, visitById, slotsOf]);
  const worksToday = (s: WithId<Staff>) => s.active && (slotsOf.get(s.id)?.slots.length ?? 0) > 0;
  /** 担当に選べる人：その日に働ける人を先に、休みの人は後ろ（休止中の人は、すでに担当している訪問があるときだけ） */
  const choosable = [...staff.filter(worksToday), ...staff.filter((s) => s.active && !worksToday(s))];
  /** 列を出す人：在籍中の全員（働ける人が先）と、担当の訪問がある休止中の人 */
  const columns = [...choosable, ...staff.filter((s) => !s.active && (view.cols[s.id]?.length ?? 0) > 0)];
  const sortedVisits = useMemo(() => timeOrder([...visitById.keys()], visitById), [visitById]);
  const warningsFor = (id: string): Warning[] => {
    const v = visitById.get(id);
    const owner = ownerOf.get(id) ?? null;
    if (!v || !owner) return [];
    return warningsOf(
      staffById.get(owner),
      owner,
      slotsOf.get(owner)?.slots ?? [],
      clientById.get(v.clientId),
      ngById.get(v.clientId) ?? [],
      times.get(id),
    );
  };

  // ドラッグ：訪問を別の担当の列（か未割当）へ移す。移すと時間が重なる・稼働時間外になる列は、ドラッグ中から赤くする
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTo, setDropTo] = useState<string | null>(null);
  const dropWarning = (to: string): Warning[] => {
    if (!dragging || to === NONE || ownerOf.get(dragging) === to) return [];
    const next = assign(view, dragging, to, visitById);
    const t = timesOf(next.cols[to] ?? [], visitById, slotsOf.get(to)?.slots).get(dragging);
    const v = visitById.get(dragging);
    return warningsOf(
      staffById.get(to),
      to,
      slotsOf.get(to)?.slots ?? [],
      v && clientById.get(v.clientId),
      v ? (ngById.get(v.clientId) ?? []) : [],
      t,
    );
  };
  const dropProps = (to: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTo !== to) setDropTo(to);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTo(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain') || dragging;
      setDragging(null);
      setDropTo(null);
      if (id && visitById.has(id) && (ownerOf.get(id) ?? NONE) !== to) setView(assign(view, id, to, visitById));
    },
  });
  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      setDragging(id);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTo(null);
    },
  });

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
            訪問を追加
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
            <p className="sub">
              訪問ごとに担当の{terms.staff}を選ぶと、下の「{terms.staff}ごとの予定」に入ります。
            </p>
            <div className="table-scroll">
              <table className="visit-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>{terms.client}</th>
                    <th className="num">所要</th>
                    <th>担当</th>
                    <th>注意</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedVisits.map((id) => {
                    const v = visitById.get(id);
                    if (!v) return null;
                    const owner = ownerOf.get(id) ?? null;
                    const warnings = warningsFor(id);
                    return (
                      <tr key={id} className={owner ? '' : 'row-unassigned'}>
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
                            className={`staff-select ${isRed(warnings) ? 'is-red' : ''}`}
                            value={owner ?? NONE}
                            style={{ borderLeftColor: owner ? colorOfStaff.get(owner) : 'var(--warn)' }}
                            onChange={(e) => setView(assign(view, id, e.target.value, visitById))}
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
                          <WarningChips warnings={warnings} />
                        </td>
                        <td className="nowrap">
                          <button type="button" className="btn btn-small" onClick={() => setEditing(id)}>
                            編集
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
            <h3>{terms.staff}ごとの予定</h3>
            <p className="sub">
              訪問をドラッグして別の{terms.staff}へ移せます。順番は開始時刻の順です（時刻は移動時間を入れない目安）。
              時間が重なる・稼働時間外になると赤い枠で知らせます。
            </p>
            <div className="route-grid">
              <div className={`route-col route-col-none ${dropTo === NONE ? 'is-drop' : ''}`} {...dropProps(NONE)}>
                <div className="spread">
                  <strong>未割当</strong>
                  <span className="sub nowrap">{view.unassigned.length}件</span>
                </div>
                {view.unassigned.length === 0 && <span className="sub">ここへドラッグすると未割当に戻せます</span>}
                {view.unassigned.map((id) => {
                  const v = visitById.get(id);
                  if (!v) return null;
                  return (
                    <div key={id} className={`route-item ${dragging === id ? 'is-dragging' : ''}`} {...dragProps(id)}>
                      <div className="sub nowrap">
                        {windowText(v)}（{v.durationMinutes}分）
                      </div>
                      {clientCell(v)}
                    </div>
                  );
                })}
              </div>
              {columns.map((s) => {
                const ids = view.cols[s.id] ?? [];
                const avail = slotsOf.get(s.id);
                const preview = dropTo === s.id ? dropWarning(s.id) : [];
                return (
                  <div
                    key={s.id}
                    className={[
                      'route-col',
                      worksToday(s) ? '' : 'is-off',
                      dropTo === s.id ? 'is-drop' : '',
                      isRed(preview) ? 'is-red' : '',
                    ].join(' ')}
                    style={{ borderTopColor: colorOfStaff.get(s.id) }}
                    {...dropProps(s.id)}
                  >
                    <div className="spread">
                      <strong className="ellipsis">{s.name}</strong>
                      <span className="sub nowrap">{ids.length}件</span>
                    </div>
                    <span className={`sub ${worksToday(s) ? '' : 'warn-text'}`}>
                      {s.active ? slotsText(avail?.slots ?? []) : '休止中'}
                      {avail?.overridden && '（この日だけ変更）'}
                    </span>
                    {preview.length > 0 && (
                      <div className="drop-warning">
                        ここに移すと：
                        <WarningChips warnings={preview} />
                      </div>
                    )}
                    {ids.map((id) => {
                      const v = visitById.get(id);
                      const t = times.get(id);
                      if (!v) return null;
                      const warnings = warningsFor(id);
                      return (
                        <div
                          key={id}
                          className={`route-item ${isRed(warnings) ? 'is-red' : ''} ${dragging === id ? 'is-dragging' : ''}`}
                          {...dragProps(id)}
                        >
                          <div className={`sub nowrap ${isRed(warnings) ? 'red-text' : ''}`}>
                            {t ? `${hhmm(t.start)}〜${hhmm(t.end)}` : v.earliestStart}
                          </div>
                          {clientCell(v)}
                          {warnings.length > 0 && <WarningChips warnings={warnings} />}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="card stack">
              <h3>手作業案の地図（点線：{terms.staff}ごとのルート、「家」は自宅）</h3>
              <RouteMap points={points} lines={lines} height={460} />
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
                変更を戻す
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

function WarningChips({ warnings }: { warnings: Warning[] }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
      {warnings.map((w) => (
        <span key={w} className={`chip ${w === 'overlap' || w === 'outside' ? 'chip-red' : 'chip-warn'}`}>
          {WARNING_LABELS[w]}
        </span>
      ))}
    </div>
  );
}
