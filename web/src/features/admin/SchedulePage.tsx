import { type Client, type ManualPlan, manualPlanSchema, type Staff, type Visit, visitSchema } from '@vrp/shared';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { type MapLine, type MapPoint, RouteMap } from '../../components/RouteMap';
import { useToast } from '../../components/Toast';
import { colorOf, initialOf } from '../../lib/colors';
import { db } from '../../lib/firebase';
import { useSession } from '../../lib/session';
import { useOrgCollection, useOrgDoc, type WithId } from '../../lib/useCollection';
import { addDays, DateField, formError, hasLocation, staffColor, tomorrow, useAdmin } from './common';

/** 予定＝その日の訪問と手作業案（スタッフ列への割り当てと順番） */

const NONE = '__none';
type Cols = Record<string, string[]>;
type View = { cols: Cols; unassigned: string[] };

/** 保存済み/編集中の並びと、いまある訪問を突き合わせる（消えた訪問を除き、新しい訪問は担当の列か未割当へ） */
function reconcile(base: Cols, visits: WithId<Visit>[], staffIds: string[]): View {
  const alive = new Set(visits.map((v) => v.id));
  const placed = new Set<string>();
  const unassigned: string[] = [];
  for (const id of base[NONE] ?? []) {
    if (alive.has(id) && !placed.has(id)) {
      unassigned.push(id);
      placed.add(id);
    }
  }
  const cols: Cols = {};
  for (const s of staffIds) {
    cols[s] = (base[s] ?? []).filter((id) => alive.has(id) && !placed.has(id));
    for (const id of cols[s]) placed.add(id);
  }
  const rest = visits.filter((v) => !placed.has(v.id)).sort((a, b) => a.earliestStart.localeCompare(b.earliestStart));
  for (const v of rest) {
    const col = v.staffId ? cols[v.staffId] : undefined;
    if (col) col.push(v.id);
    else unassigned.push(v.id);
  }
  return { cols, unassigned };
}

type VisitForm = {
  id: string | null;
  clientId: string;
  windowKind: 'fixed' | 'window';
  earliestStart: string;
  latestStart: string;
  durationMinutes: string;
  note: string;
};

export default function SchedulePage() {
  const { orgId, terms } = useAdmin();
  const session = useSession();
  const toast = useToast();
  const [date, setDate] = useState(tomorrow);
  const visitsQ = useOrgCollection<Visit>(orgId, 'visits', [where('date', '==', date)], date);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const planDoc = useOrgDoc<ManualPlan>(orgId, 'manualPlans', date);
  const [draft, setDraft] = useState<Cols | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [form, setForm] = useState<VisitForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 日付を変えたら編集中の内容を捨てる
  useEffect(() => {
    setDraft(null);
    setMinutes(null);
    setForm(null);
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
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
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
  const shownStaff = staff.filter((s) => s.active || (view.cols[s.id]?.length ?? 0) > 0);
  const minutesValue = minutes ?? (plan?.minutesSpent != null ? String(plan.minutesSpent) : '');
  const dirty = draft !== null || minutes !== null;

  const setView = (cols: Cols, unassigned: string[]) => setDraft({ ...cols, [NONE]: unassigned });
  const moveTo = (id: string, to: string) => {
    const cols: Cols = {};
    for (const [k, ids] of Object.entries(view.cols)) cols[k] = ids.filter((x) => x !== id);
    const un = view.unassigned.filter((x) => x !== id);
    if (to === NONE) un.push(id);
    else cols[to] = [...(cols[to] ?? []), id];
    setView(cols, un);
  };
  const shift = (staffId: string, index: number, dir: -1 | 1) => {
    const ids = [...(view.cols[staffId] ?? [])];
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j] as string, ids[index] as string];
    setView({ ...view.cols, [staffId]: ids }, view.unassigned);
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
      const owner = new Map<string, string | null>();
      for (const [k, ids] of Object.entries(view.cols)) for (const id of ids) owner.set(id, k);
      for (const v of visits) {
        const next = owner.get(v.id) ?? null;
        if ((v.staffId ?? null) !== next) batch.update(doc(db, 'orgs', orgId, 'visits', v.id), { staffId: next });
      }
      await batch.commit();
      setDraft(null);
      setMinutes(null);
      toast('手作業案を保存しました');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  const openNew = () =>
    setForm({
      id: null,
      clientId: clients.find((c) => c.active)?.id ?? '',
      windowKind: 'fixed',
      earliestStart: '09:00',
      latestStart: '09:00',
      durationMinutes: '60',
      note: '',
    });
  const openEdit = (v: WithId<Visit>) =>
    setForm({
      id: v.id,
      clientId: v.clientId,
      windowKind: v.windowKind,
      earliestStart: v.earliestStart,
      latestStart: v.latestStart,
      durationMinutes: String(v.durationMinutes),
      note: v.note,
    });

  const saveVisit = async () => {
    if (!form) return;
    setError(null);
    try {
      const old = form.id ? visitById.get(form.id) : undefined;
      const data = visitSchema.parse({
        date,
        clientId: form.clientId,
        windowKind: form.windowKind,
        earliestStart: form.earliestStart,
        latestStart: form.windowKind === 'fixed' ? form.earliestStart : form.latestStart,
        durationMinutes: Number(form.durationMinutes),
        staffId: old?.staffId ?? null,
        cancelled: false,
        note: form.note,
      });
      if (data.latestStart < data.earliestStart)
        throw new Error('「いちばん遅い開始」は「いちばん早い開始」より後にしてください');
      await setDoc(doc(db, 'orgs', orgId, 'visits', form.id ?? crypto.randomUUID()), data);
      setForm(null);
      toast('訪問を保存しました');
    } catch (e) {
      setError(e instanceof Error && !('issues' in e) ? e.message : formError(e));
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

  // 地図：スタッフごとの手作業ルート（点線）
  const { points, lines } = useMemo(() => {
    const pts: MapPoint[] = [];
    const lns: MapLine[] = [];
    const seen = new Set<string>();
    staff.forEach((s, i) => {
      const ids = view.cols[s.id] ?? [];
      if (ids.length === 0) return;
      const path: { lat: number; lng: number }[] = [];
      const home = hasLocation(s.home) ? { lat: s.home.lat, lng: s.home.lng } : null;
      if (home) {
        path.push(home);
        pts.push({ ...home, label: '家', color: staffColor(i) });
      }
      for (const id of ids) {
        const v = visitById.get(id);
        const c = v && clientById.get(v.clientId);
        if (!c || !hasLocation(c.place)) continue;
        path.push({ lat: c.place.lat, lng: c.place.lng });
        if (!seen.has(id)) {
          seen.add(id);
          pts.push({ lat: c.place.lat, lng: c.place.lng, label: initialOf(c.displayName), color: colorOf(c.color) });
        }
      }
      if (home && path.length > 1) path.push(home);
      lns.push({ points: path, color: staffColor(i), dashed: true });
    });
    return { points: pts, lines: lns };
  }, [staff, view, visitById, clientById]);

  const visitLine = (v: WithId<Visit>) => {
    const c = clientById.get(v.clientId);
    return (
      <div className="row" style={{ flex: 1, minWidth: 0 }}>
        <span className="dot dot-sm" style={{ background: colorOf(c?.color ?? 0) }}>
          {initialOf(c?.displayName ?? '?')}
        </span>
        <div style={{ minWidth: 0 }}>
          <div>
            {v.earliestStart}
            {v.windowKind === 'window' ? `〜${v.latestStart}` : ''} {c?.displayName ?? '（不明）'}　{v.durationMinutes}
            分
          </div>
          {v.note && <div className="sub">{v.note}</div>}
        </div>
      </div>
    );
  };

  const moveSelect = (id: string, current: string) => (
    <select
      value={current}
      style={{ width: 120, padding: '4px 6px' }}
      onChange={(e) => moveTo(id, e.target.value)}
      aria-label="担当を変える"
    >
      <option value={NONE}>未割当</option>
      {shownStaff.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );

  const itemActions = (v: WithId<Visit>) => (
    <>
      <button type="button" className="btn btn-small" onClick={() => openEdit(v)}>
        直す
      </button>
      <button type="button" className="btn btn-small" onClick={() => cancelVisit(v)}>
        取り消す
      </button>
    </>
  );

  return (
    <div className="stack">
      <h2>予定</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField value={date} onChange={setDate} />
          <button type="button" className="btn" onClick={openNew} disabled={clients.length === 0}>
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

      {form && (
        <div className="card stack">
          <h3>{form.id ? '訪問を直す' : '訪問を足す'}</h3>
          <div className="form-grid">
            <label>
              {terms.client}
              <select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
                <option value="">選んでください</option>
                {clients
                  .filter((c) => c.active || c.id === form.clientId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              時間の約束
              <select
                value={form.windowKind}
                onChange={(e) => setForm({ ...form, windowKind: e.target.value as 'fixed' | 'window' })}
              >
                <option value="fixed">開始時刻が決まっている</option>
                <option value="window">開始に幅がある</option>
              </select>
            </label>
            <label>
              {form.windowKind === 'fixed' ? '開始時刻' : 'いちばん早い開始'}
              <input
                type="time"
                value={form.earliestStart}
                onChange={(e) => setForm({ ...form, earliestStart: e.target.value })}
              />
            </label>
            {form.windowKind === 'window' && (
              <label>
                いちばん遅い開始
                <input
                  type="time"
                  value={form.latestStart}
                  onChange={(e) => setForm({ ...form, latestStart: e.target.value })}
                />
              </label>
            )}
            <label>
              所要時間（分）
              <input
                type="number"
                min={5}
                max={720}
                value={form.durationMinutes}
                onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
              />
            </label>
            <label>
              メモ
              <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={saveVisit}>
              保存
            </button>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}

      <div className="card stack">
        <div className="spread">
          <h3>手作業案（{terms.staff}の列に割り当てて、順番を決める）</h3>
          {dirty && <span className="chip chip-warn">未保存の変更があります</span>}
        </div>
        {allVisits === null ? (
          <p className="sub">読み込み中…</p>
        ) : visits.length === 0 ? (
          <p className="sub">この日の訪問はまだありません。</p>
        ) : (
          <>
            <div className="grid2">
              <div className="card stack" style={{ background: '#faf6f2' }}>
                <strong>未割当（{view.unassigned.length}件）</strong>
                {view.unassigned.map((id) => {
                  const v = visitById.get(id);
                  if (!v) return null;
                  return (
                    <div key={id} className="row" style={{ flexWrap: 'wrap' }}>
                      {visitLine(v)}
                      {moveSelect(id, NONE)}
                      {itemActions(v)}
                    </div>
                  );
                })}
              </div>
              {shownStaff.map((s, i) => {
                const ids = view.cols[s.id] ?? [];
                return (
                  <div key={s.id} className="card stack" style={{ borderLeft: `6px solid ${staffColor(i)}` }}>
                    <strong>
                      {s.name}（{ids.length}件）{!s.active && <span className="chip">休止中</span>}
                    </strong>
                    {ids.length === 0 && <span className="sub">訪問なし</span>}
                    {ids.map((id, idx) => {
                      const v = visitById.get(id);
                      if (!v) return null;
                      return (
                        <div key={id} className="row" style={{ flexWrap: 'wrap' }}>
                          <span className="sub">{idx + 1}</span>
                          {visitLine(v)}
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={idx === 0}
                            onClick={() => shift(s.id, idx, -1)}
                            aria-label="上へ"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={idx === ids.length - 1}
                            onClick={() => shift(s.id, idx, 1)}
                            aria-label="下へ"
                          >
                            ▼
                          </button>
                          {moveSelect(id, s.id)}
                          {itemActions(v)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ maxWidth: 260 }}>
                ルート作成にかかった時間（分）
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={minutesValue}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
              <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={savePlan}>
                手作業案を保存
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(null);
                    setMinutes(null);
                  }}
                >
                  変更をもどす
                </button>
              )}
            </div>
            <p className="sub">保存すると、各訪問の担当もこの列のとおりに変わります。</p>
          </>
        )}
      </div>

      {lines.length > 0 && (
        <div className="card stack">
          <h3>手作業案の地図（点線：{terms.staff}ごとのルート、「家」は自宅）</h3>
          <RouteMap points={points} lines={lines} height={320} />
        </div>
      )}
    </div>
  );
}
